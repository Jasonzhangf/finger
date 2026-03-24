/**
 * Ledger read-only API routes
 * Exposes ledger data for UI inspection and ledger-based session listing.
 */

import type { Express } from 'express';
import { existsSync, readFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import type { SessionManager } from '../../orchestration/session-manager.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { readdirSync, statSync } from 'fs';

interface LedgerRouteDeps {
  sessionManager: SessionManager;
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

function safeParseJsonLines(filePath: string): Array<Record<string, unknown>> {
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, 'utf-8').trim();
    if (!raw) return [];
    return raw.split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
  } catch {
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
  } catch {
    return null;
  }
}

interface LedgerSourceCandidate {
  storageDir: string;
  agentId: string;
  ledgerEntries: Array<Record<string, unknown>>;
  compactEntries: Array<Record<string, unknown>>;
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
  } catch {
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
} {
  const storageCandidates = buildSessionStorageCandidates(sessionId, storageDir);
  let fallbackStorageDir: string | null = null;
  const sources: LedgerSourceCandidate[] = [];

  for (const candidateDir of storageCandidates) {
    try {
      if (!existsSync(candidateDir) || !statSync(candidateDir).isDirectory()) continue;
      if (!fallbackStorageDir) fallbackStorageDir = candidateDir;
      sources.push(...collectLedgerSourceCandidates(candidateDir));
    } catch {
      continue;
    }
  }

  if (sources.length === 0) {
    return { source: null, fallbackStorageDir };
  }

  const ranked = sources
    .slice()
    .sort((a, b) => {
      const aHasLedger = a.ledgerEntries.length > 0 ? 1 : 0;
      const bHasLedger = b.ledgerEntries.length > 0 ? 1 : 0;
      if (aHasLedger !== bHasLedger) return bHasLedger - aHasLedger;
      const aPreferred = a.agentId === preferredAgentId ? 1 : 0;
      const bPreferred = b.agentId === preferredAgentId ? 1 : 0;
      if (aPreferred !== bPreferred) return bPreferred - aPreferred;
      if (a.ledgerEntries.length !== b.ledgerEntries.length) return b.ledgerEntries.length - a.ledgerEntries.length;
      return b.compactEntries.length - a.compactEntries.length;
    });

  return { source: ranked[0] ?? null, fallbackStorageDir };
}

function resolveLedgerSource(
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
  let resolvedAgentId = picked.source?.agentId ?? preferredAgentId;
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

function summarizeLedgerSessionDir(dirPath: string): {
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
} | null {
  try {
    const stat = statSync(dirPath);
    if (!stat.isDirectory()) return null;
    const dirName = dirPath.split('/').pop() || '';
    if (!dirName) return null;

    // Prefer canonical session metadata when available.
    // session metadata dirs are expected to contain main.json / agent-*.json directly.
    const mainMeta = safeParseJsonFile(join(dirPath, 'main.json'));
    const metadata = mainMeta;
    const metadataId = typeof metadata?.id === 'string' ? metadata.id : '';
    const sessionId = metadataId || dirName;

    // Guard: internal ledger workspace dirs (e.g. system-<id>) are not standalone sessions.
    // If a system-like dir has no metadata file, skip it to avoid duplicate phantom sessions in UI.
    if (!metadata && dirName.startsWith('system-')) {
      return null;
    }

    // scan agent subdirs for ledger files
    const children = readdirSync(dirPath, { withFileTypes: true }).filter((d) => d.isDirectory());
    const ledgerEntries: Array<Record<string, unknown>> = [];
    let ownerAgentId: string | undefined;

    for (const child of children) {
      const ledgerPath = join(dirPath, child.name, 'main', 'context-ledger.jsonl');
      const entries = safeParseJsonLines(ledgerPath);
      if (entries.length > 0) {
        ledgerEntries.push(...entries);
        if (!ownerAgentId) ownerAgentId = child.name;
      }
    }

    // fallback legacy path: session/<agent>/main
    if (ledgerEntries.length === 0) {
      const fallbackAgent = 'finger-system-agent';
      const fallbackPath = join(dirPath, fallbackAgent, 'main', 'context-ledger.jsonl');
      const entries = safeParseJsonLines(fallbackPath);
      if (entries.length > 0) {
        ledgerEntries.push(...entries);
        ownerAgentId = fallbackAgent;
      }
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
    const metadataMessageCount = Array.isArray(metadata?.messages) ? metadata.messages.length : undefined;

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
        messageCount: typeof metadataMessageCount === 'number' ? metadataMessageCount : 0,
        totalTokens: fallbackTotalTokens,
        lastAccessedAt: fallbackLastAccessedAt,
        ...(sessionTier ? { sessionTier } : {}),
        ...((ownerAgentIdFromContext || ownerAgentId) ? { ownerAgentId: ownerAgentIdFromContext || ownerAgentId } : {}),
        ...(rootSessionId ? { rootSessionId } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
      };
    }

    const sorted = ledgerEntries
      .filter((e) => typeof e.timestamp_ms === 'number')
      .sort((a, b) => Number(a.timestamp_ms) - Number(b.timestamp_ms));

    const last = sorted[sorted.length - 1];
    const first = sorted[0];

    const messages = ledgerEntries.filter((e) => e.event_type === 'session_message');
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
      messageCount: typeof metadataMessageCount === 'number' ? metadataMessageCount : messages.length,
      totalTokens,
      lastAccessedAt: String(last?.timestamp_iso || new Date(stat.mtimeMs).toISOString()),
      ...(sessionTier ? { sessionTier } : {}),
      ...((ownerAgentIdFromContext || ownerAgentId) ? { ownerAgentId: ownerAgentIdFromContext || ownerAgentId } : {}),
      ...(rootSessionId ? { rootSessionId } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
    };
  } catch {
    return null;
  }
}

export function listLedgerSessionsSnapshot(): Array<Record<string, unknown>> {
  const roots = [
    join(FINGER_PATHS.home, 'system', 'sessions'),
    FINGER_PATHS.sessions.dir,
  ];

  const collected = new Map<string, Record<string, unknown>>();

  for (const root of roots) {
    if (!existsSync(root)) continue;
    let dirs: string[] = [];
    try {
      dirs = readdirSync(root)
        .map((name) => join(root, name))
        .filter((p) => {
          try {
            return statSync(p).isDirectory();
          } catch {
            return false;
          }
        });
    } catch {
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

  return Array.from(collected.values()).sort((a, b) => {
    const ta = Date.parse(String(a.lastAccessedAt || 0)) || 0;
    const tb = Date.parse(String(b.lastAccessedAt || 0)) || 0;
    return tb - ta;
  });
}

export function registerLedgerRoutes(app: Express, deps: LedgerRouteDeps): void {
  const { sessionManager } = deps;

  // Ledger-based session list (SSOT for new UI)
  app.get('/api/v1/ledger/sessions', (_req, res) => {
    const sessions = listLedgerSessionsSnapshot();
    res.json({ success: true, sessions });
  });

  app.get('/api/v1/sessions/:sessionId/ledger', async (req, res) => {
    try {
      const resolved = resolveLedgerSource(sessionManager, req.params.sessionId);
      if (!resolved) {
        res.status(404).json({ error: 'Storage dir not found' });
        return;
      }
      const { sessionId, session, ledgerEntries, compactEntries } = resolved;

      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
      const paged = ledgerEntries.slice(Math.max(0, offset), Math.min(ledgerEntries.length, offset + limit));

      const slots = paged.map((entry, idx) => ({
        slot: offset + idx + 1,
        id: entry.id ?? '',
        timestamp_ms: entry.timestamp_ms ?? 0,
        timestamp_iso: entry.timestamp_iso ?? '',
        event_type: entry.event_type ?? '',
        agent_id: entry.agent_id ?? '',
        mode: entry.mode ?? '',
        role: (entry.payload as Record<string, unknown>)?.role ?? '',
        content_preview: typeof (entry.payload as Record<string, unknown>)?.content === 'string'
          ? String((entry.payload as Record<string, unknown>).content).slice(0, 200)
          : JSON.stringify(entry.payload ?? {}).slice(0, 200),
      }));

      res.json({
        success: true,
        total: ledgerEntries.length,
        offset,
        limit,
        slots,
        compactCount: compactEntries.length,
        sessionMeta: {
          id: session?.id || sessionId,
          name: session?.name || sessionId,
          projectPath: session?.projectPath || '',
          totalTokens: session?.totalTokens || 0,
          originalStartIndex: session?.originalStartIndex || 0,
          originalEndIndex: session?.originalEndIndex || 0,
          latestCompactIndex: session?.latestCompactIndex || -1,
        },
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/api/v1/sessions/:sessionId/ledger/:slot', async (req, res) => {
    try {
      const resolved = resolveLedgerSource(sessionManager, req.params.sessionId);
      if (!resolved) {
        res.status(404).json({ error: 'Storage dir not found' });
        return;
      }
      const { sessionId, ledgerEntries } = resolved;
      const slot = parseInt(req.params.slot, 10);
      if (!Number.isFinite(slot) || slot < 1) {
        res.status(400).json({ error: 'Invalid slot' });
        return;
      }

      const entry = ledgerEntries[slot - 1];
      if (!entry) {
        res.status(404).json({ error: 'Slot not found' });
        return;
      }

      const payload = (entry.payload as Record<string, unknown>) ?? {};
      const rawContent = typeof payload.content === 'string'
        ? payload.content
        : JSON.stringify(payload ?? {}, null, 2);

      res.json({
        success: true,
        sessionId,
        slot,
        detail: {
          slot,
          id: entry.id ?? '',
          timestamp_ms: entry.timestamp_ms ?? 0,
          timestamp_iso: entry.timestamp_iso ?? '',
          event_type: entry.event_type ?? '',
          agent_id: entry.agent_id ?? '',
          mode: entry.mode ?? '',
          role: payload.role ?? '',
          content_preview: typeof payload.content === 'string'
            ? String(payload.content).slice(0, 200)
            : JSON.stringify(payload ?? {}).slice(0, 200),
          content_full: rawContent,
          payload,
          raw_entry: entry,
        },
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
