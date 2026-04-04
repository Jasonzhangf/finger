import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import type { SessionManager } from '../../orchestration/session-manager.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { logger } from '../../core/logger.js';

const log = logger.module('LedgerRoutesStorage');

function safeParseJsonLines(filePath: string): Array<Record<string, unknown>> {
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, 'utf-8').trim();
    if (!raw) return [];
    let parseFailures = 0;
    const parsed = raw.split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch (err) {
        parseFailures += 1;
        log.debug('Failed to parse JSONL line, keeping placeholder', {
          filePath,
          error: err instanceof Error ? err.message : String(err),
          linePreview: line.slice(0, 120),
        });
        return {};
      }
    });
    if (parseFailures > 0) {
      log.warn('JSONL parse had failures', {
        filePath,
        parseFailures,
      });
    }
    return parsed;
  } catch (err) {
    log.warn('Failed to read JSONL file, fallback to empty list', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function safeParseJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch (err) {
    log.warn('Failed to parse JSON file, fallback to null', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function summarizePreviewContent(content: string, maxChars = 80): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function resolveSystemSessionId(sessionManager: SessionManager, sessionId: string): string {
  if (sessionId === 'system-default-session' || sessionId === 'system-1') {
    return sessionManager.getOrCreateSystemSession().id;
  }
  if (sessionId.startsWith('system-')) {
    const existing = sessionManager.getSession(sessionId);
    if (!existing) {
      return sessionManager.getOrCreateSystemSession().id;
    }
  }
  return sessionId;
}

interface LedgerSourceCandidate {
  storageDir: string;
  agentId: string;
  ledgerEntries: Array<Record<string, unknown>>;
  compactEntries: Array<Record<string, unknown>>;
}

interface LedgerChildSessionSummary {
  id: string;
  name: string;
  ownerAgentId?: string;
  sessionTier?: string;
  messageCount: number;
  lastAccessedAt: string;
  lastMessageAt?: string;
}

interface LedgerSessionSummary {
  id: string;
  lastAccessedAt: string;
  projectPath: string;
  name: string;
  messageCount: number;
  totalTokens: number;
  sessionTier?: string;
  ownerAgentId?: string;
  rootSessionId?: string;
  parentSessionId?: string;
  sessionWorkspaceRoot?: string;
  lastMessageAt?: string;
  previewSummary?: string;
  previewMessages?: Array<{
    role: 'user' | 'assistant' | 'system' | 'orchestrator';
    timestamp: string;
    summary: string;
  }>;
  relationKind?: 'standalone' | 'root' | 'child';
  isRuntimeChild?: boolean;
  childSessionCount?: number;
  childSessions?: LedgerChildSessionSummary[];
}

function collectLedgerSourceCandidates(storageDir: string): LedgerSourceCandidate[] {
  try {
    if (!existsSync(storageDir) || !statSync(storageDir).isDirectory()) return [];
    const children = readdirSync(storageDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const candidates: LedgerSourceCandidate[] = [];
    for (const child of children) {
      const ledgerPath = join(storageDir, child.name, 'main', 'context-ledger.jsonl');
      const compactPath = join(storageDir, child.name, 'main', 'compact-memory.jsonl');
      const hasLedgerFile = existsSync(ledgerPath);
      const hasCompactFile = existsSync(compactPath);
      if (!hasLedgerFile && !hasCompactFile) continue;
      const ledgerEntries = safeParseJsonLines(ledgerPath);
      const compactEntries = safeParseJsonLines(compactPath);
      candidates.push({
        storageDir,
        agentId: child.name,
        ledgerEntries,
        compactEntries,
      });
    }
    return candidates;
  } catch (err) {
    log.warn('Failed to collect ledger source candidates', {
      storageDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function buildSessionStorageCandidates(sessionId: string, storageDir: string | null): string[] {
  const rootSystemSessions = join(FINGER_PATHS.home, 'system', 'sessions');
  const rootProjectSessions = FINGER_PATHS.sessions.dir;
  const candidates: string[] = [];
  const pushCandidate = (value: string | null | undefined): void => {
    if (!value) return;
    const normalized = value.trim();
    if (!normalized) return;
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  pushCandidate(storageDir);
  pushCandidate(join(rootSystemSessions, sessionId));
  pushCandidate(join(rootProjectSessions, sessionId));
  pushCandidate(join(rootSystemSessions, `session-${sessionId}`));
  pushCandidate(join(rootProjectSessions, `session-${sessionId}`));

  if (sessionId.startsWith('session-')) {
    const bareSessionId = sessionId.slice('session-'.length);
    pushCandidate(join(rootSystemSessions, bareSessionId));
    pushCandidate(join(rootProjectSessions, bareSessionId));
  }

  if (storageDir) {
    const base = basename(storageDir);
    const parent = dirname(storageDir);
    if (base.startsWith('session-')) {
      pushCandidate(join(parent, base.slice('session-'.length)));
    } else {
      pushCandidate(join(parent, `session-${base}`));
    }
  }

  return candidates;
}

function pickBestLedgerSource(sessionId: string, storageDir: string | null, preferredAgentId: string): {
  source: LedgerSourceCandidate | null;
  fallbackStorageDir: string | null;
  sources: LedgerSourceCandidate[];
} {
  const storageCandidates = buildSessionStorageCandidates(sessionId, storageDir);
  let fallbackStorageDir: string | null = null;
  const sources: LedgerSourceCandidate[] = [];

  for (const candidateDir of storageCandidates) {
    try {
      if (!existsSync(candidateDir) || !statSync(candidateDir).isDirectory()) continue;
      if (!fallbackStorageDir) fallbackStorageDir = candidateDir;
      sources.push(...collectLedgerSourceCandidates(candidateDir));
    } catch (err) {
      log.debug('Skip invalid storage candidate directory', {
        candidateDir,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
  }

  if (sources.length === 0) {
    return { source: null, fallbackStorageDir, sources };
  }

  const ranked = sources.slice().sort((a, b) => {
    const aHasLedger = a.ledgerEntries.length > 0 ? 1 : 0;
    const bHasLedger = b.ledgerEntries.length > 0 ? 1 : 0;
    if (aHasLedger !== bHasLedger) return bHasLedger - aHasLedger;
    const aPreferred = a.agentId === preferredAgentId ? 1 : 0;
    const bPreferred = b.agentId === preferredAgentId ? 1 : 0;
    if (aPreferred !== bPreferred) return bPreferred - aPreferred;
    if (a.ledgerEntries.length !== b.ledgerEntries.length) return b.ledgerEntries.length - a.ledgerEntries.length;
    return b.compactEntries.length - a.compactEntries.length;
  });

  return { source: ranked[0] ?? null, fallbackStorageDir, sources };
}

export function resolveLedgerSource(
  sessionManager: SessionManager,
  requestedSessionId: string,
): {
  sessionId: string;
  session: ReturnType<SessionManager['getSession']>;
  resolvedStorageDir: string;
  resolvedAgentId: string;
  ledgerEntries: Array<Record<string, unknown>>;
  compactEntries: Array<Record<string, unknown>>;
} | null {
  const sessionId = resolveSystemSessionId(sessionManager, requestedSessionId);
  const session = sessionManager.getSession(sessionId);
  const storageDir = sessionManager.resolveSessionStorageDir(sessionId);

  let preferredAgentId = 'finger-system-agent';
  if (session?.context && typeof session.context.ownerAgentId === 'string') {
    preferredAgentId = session.context.ownerAgentId;
  }

  const picked = pickBestLedgerSource(sessionId, storageDir, preferredAgentId);
  const resolvedStorageDir = picked.source?.storageDir ?? picked.fallbackStorageDir;
  const resolvedAgentId = picked.source?.agentId ?? preferredAgentId;
  let ledgerEntries = picked.source?.ledgerEntries ?? [];
  let compactEntries = picked.source?.compactEntries ?? [];

  if (!resolvedStorageDir) {
    return null;
  }

  if (!picked.source) {
    const ledgerPath = join(resolvedStorageDir, resolvedAgentId, 'main', 'context-ledger.jsonl');
    const compactPath = join(resolvedStorageDir, resolvedAgentId, 'main', 'compact-memory.jsonl');
    ledgerEntries = safeParseJsonLines(ledgerPath);
    compactEntries = safeParseJsonLines(compactPath);
  }

  return {
    sessionId,
    session,
    resolvedStorageDir,
    resolvedAgentId,
    ledgerEntries,
    compactEntries,
  };
}

function summarizeLedgerSessionDir(dirPath: string): LedgerSessionSummary | null {
  try {
    const stat = statSync(dirPath);
    if (!stat.isDirectory()) return null;
    const dirName = dirPath.split('/').pop() || '';
    if (!dirName) return null;

    const mainMeta = safeParseJsonFile(join(dirPath, 'main.json'));
    const metadata = mainMeta;
    const metadataId = typeof metadata?.id === 'string' ? metadata.id : '';
    const sessionId = metadataId || dirName;
    if (!metadata && dirName.startsWith('system-')) {
      return null;
    }

    const context = metadata && typeof metadata.context === 'object' && metadata.context !== null
      ? metadata.context as Record<string, unknown>
      : {};
    const sessionTier = typeof context.sessionTier === 'string'
      ? context.sessionTier
      : (sessionId.startsWith('system-') ? 'system' : undefined);
    const ownerAgentIdFromContext = typeof context.ownerAgentId === 'string'
      ? context.ownerAgentId
      : undefined;
    const rootSessionId = typeof context.rootSessionId === 'string' ? context.rootSessionId : undefined;
    const parentSessionId = typeof context.parentSessionId === 'string' ? context.parentSessionId : undefined;
    const sessionWorkspaceRoot = typeof context.sessionWorkspaceRoot === 'string'
      ? context.sessionWorkspaceRoot
      : undefined;
    const preferredAgentId = ownerAgentIdFromContext || 'finger-system-agent';
    const picked = pickBestLedgerSource(sessionId, dirPath, preferredAgentId);
    const ledgerEntries = picked.source?.ledgerEntries ?? [];
    const ownerAgentId = picked.source?.agentId;

    if (ledgerEntries.length === 0) {
      if (!metadata) return null;
      const fallbackProjectPath = typeof metadata.projectPath === 'string'
        ? metadata.projectPath
        : (sessionId.startsWith('system-') ? join(FINGER_PATHS.home, 'system') : FINGER_PATHS.home);
      const fallbackLastAccessedAt = typeof metadata.lastAccessedAt === 'string'
        ? metadata.lastAccessedAt
        : new Date(stat.mtimeMs).toISOString();
      const fallbackTotalTokens = typeof metadata.totalTokens === 'number' ? metadata.totalTokens : 0;
      return {
        id: sessionId,
        name: typeof metadata.name === 'string' ? metadata.name : sessionId,
        projectPath: fallbackProjectPath,
        messageCount: 0,
        totalTokens: fallbackTotalTokens,
        lastAccessedAt: fallbackLastAccessedAt,
        ...(sessionTier ? { sessionTier } : {}),
        ...((ownerAgentIdFromContext || ownerAgentId) ? { ownerAgentId: ownerAgentIdFromContext || ownerAgentId } : {}),
        ...(rootSessionId ? { rootSessionId } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(sessionWorkspaceRoot ? { sessionWorkspaceRoot } : {}),
      };
    }

    const sorted = ledgerEntries
      .filter((e) => typeof e.timestamp_ms === 'number')
      .sort((a, b) => Number(a.timestamp_ms) - Number(b.timestamp_ms));
    const last = sorted[sorted.length - 1];
    const first = sorted[0];
    const messages = ledgerEntries.filter((e) => e.event_type === 'session_message');
    const previewMessages = messages
      .slice(-3)
      .map((entry) => {
        const payload = (entry.payload as Record<string, unknown>) || {};
        const role = typeof payload.role === 'string' ? payload.role : 'user';
        const content = typeof payload.content === 'string' ? payload.content : '';
        const timestamp = typeof entry.timestamp_iso === 'string' ? entry.timestamp_iso : '';
        return {
          role: role as 'user' | 'assistant' | 'system' | 'orchestrator',
          timestamp,
          summary: summarizePreviewContent(content),
        };
      })
      .filter((entry) => entry.timestamp.length > 0);
    const previewSummary = previewMessages
      .map((item) => `[${new Date(item.timestamp).toLocaleTimeString()}] ${item.role}: ${item.summary}`)
      .join('\n');
    const lastMessageAt = previewMessages.length > 0
      ? previewMessages[previewMessages.length - 1].timestamp
      : undefined;
    const totalTokens = messages.reduce((sum, e) => {
      const payload = (e.payload as Record<string, unknown>) || {};
      const tokenCount = typeof payload.token_count === 'number' ? payload.token_count : 0;
      return sum + tokenCount;
    }, 0);
    const projectPath = String((first?.payload as Record<string, unknown>)?.projectPath ||
      (typeof metadata?.projectPath === 'string' ? metadata.projectPath : '')
      || (sessionId.startsWith('system-') ? join(FINGER_PATHS.home, 'system') : FINGER_PATHS.home));
    return {
      id: sessionId,
      name: typeof metadata?.name === 'string' ? metadata.name : sessionId,
      projectPath,
      messageCount: messages.length,
      totalTokens,
      lastAccessedAt: String(last?.timestamp_iso || new Date(stat.mtimeMs).toISOString()),
      ...(sessionTier ? { sessionTier } : {}),
      ...((ownerAgentIdFromContext || ownerAgentId) ? { ownerAgentId: ownerAgentIdFromContext || ownerAgentId } : {}),
      ...(rootSessionId ? { rootSessionId } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(sessionWorkspaceRoot ? { sessionWorkspaceRoot } : {}),
      ...(lastMessageAt ? { lastMessageAt } : {}),
      ...(previewSummary ? { previewSummary } : {}),
      ...(previewMessages.length > 0 ? { previewMessages } : {}),
    };
  } catch (err) {
    log.warn('Failed to summarize ledger session directory', {
      dirPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function listLedgerSessionsSnapshot(): Array<Record<string, unknown>> {
  const roots = [
    join(FINGER_PATHS.home, 'system', 'sessions'),
    FINGER_PATHS.sessions.dir,
  ];

  const collected = new Map<string, LedgerSessionSummary & Record<string, unknown>>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let dirs: string[] = [];
    try {
      dirs = readdirSync(root)
        .map((name) => join(root, name))
        .filter((p) => {
          try {
            return statSync(p).isDirectory();
          } catch (err) {
            log.debug('Skip invalid session entry path', {
              sessionPath: p,
              error: err instanceof Error ? err.message : String(err),
            });
            return false;
          }
        });
    } catch (err) {
      log.warn('Failed to enumerate session root directory', {
        root,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const dir of dirs) {
      const summary = summarizeLedgerSessionDir(dir);
      if (!summary) continue;
      collected.set(summary.id, {
        ...summary,
        createdAt: summary.lastAccessedAt,
        updatedAt: summary.lastAccessedAt,
        activeWorkflows: [],
      });
    }
  }

  const sessions = Array.from(collected.values());
  const childByParent = new Map<string, LedgerChildSessionSummary[]>();

  for (const session of sessions) {
    const parentSessionId = typeof session.parentSessionId === 'string' && session.parentSessionId.trim().length > 0
      ? session.parentSessionId.trim()
      : '';
    const rootSessionId = typeof session.rootSessionId === 'string' && session.rootSessionId.trim().length > 0
      ? session.rootSessionId.trim()
      : '';
    const parentId = parentSessionId || (rootSessionId && rootSessionId !== session.id ? rootSessionId : '');
    if (!parentId) continue;

    const list = childByParent.get(parentId) ?? [];
    list.push({
      id: session.id,
      name: session.name,
      ...(session.ownerAgentId ? { ownerAgentId: session.ownerAgentId } : {}),
      ...(session.sessionTier ? { sessionTier: session.sessionTier } : {}),
      messageCount: session.messageCount,
      lastAccessedAt: session.lastAccessedAt,
      ...(session.lastMessageAt ? { lastMessageAt: session.lastMessageAt } : {}),
    });
    childByParent.set(parentId, list);
  }

  for (const session of sessions) {
    const hasParent = typeof session.parentSessionId === 'string' && session.parentSessionId.trim().length > 0;
    const hasRootOther = typeof session.rootSessionId === 'string'
      && session.rootSessionId.trim().length > 0
      && session.rootSessionId.trim() !== session.id;
    const children = childByParent.get(session.id) ?? [];

    if (hasParent || hasRootOther) {
      session.relationKind = 'child';
      session.isRuntimeChild = true;
      continue;
    }

    if (children.length > 0) {
      session.relationKind = 'root';
      session.isRuntimeChild = false;
      session.childSessionCount = children.length;
      session.childSessions = children
        .slice()
        .sort((a, b) => (Date.parse(b.lastAccessedAt) || 0) - (Date.parse(a.lastAccessedAt) || 0));
      continue;
    }

    session.relationKind = 'standalone';
    session.isRuntimeChild = false;
    session.childSessionCount = 0;
  }

  return sessions.sort((a, b) => {
    const ta = Date.parse(String(a.lastAccessedAt || 0)) || 0;
    const tb = Date.parse(String(b.lastAccessedAt || 0)) || 0;
    return tb - ta;
  });
}
