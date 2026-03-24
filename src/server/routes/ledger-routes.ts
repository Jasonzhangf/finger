/**
 * Ledger read-only API routes
 * Exposes ledger data for UI inspection and ledger-based session listing.
 */

import type { Express } from 'express';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { SessionManager } from '../../orchestration/session-manager.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { readdirSync, statSync } from 'fs';

interface LedgerRouteDeps {
  sessionManager: SessionManager;
}

function resolveSystemSessionId(sessionManager: SessionManager, sessionId: string): string {
  if (sessionId === 'system-default-session') {
    return sessionManager.getOrCreateSystemSession().id;
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
    const sessionId = dirPath.split('/').pop() || '';
    if (!sessionId) return null;

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

    if (ledgerEntries.length === 0) return null;

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
      (sessionId.startsWith('system-') ? join(FINGER_PATHS.home, 'system') : FINGER_PATHS.home));

    return {
      id: sessionId,
      name: sessionId,
      projectPath,
      messageCount: messages.length,
      totalTokens,
      lastAccessedAt: String(last?.timestamp_iso || new Date(stat.mtimeMs).toISOString()),
      ...(sessionId.startsWith('system-') ? { sessionTier: 'system' } : {}),
      ...(ownerAgentId ? { ownerAgentId } : {}),
    };
  } catch {
    return null;
  }
}

function scanLedgerSessions(): Array<Record<string, unknown>> {
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
    const sessions = scanLedgerSessions();
    res.json({ success: true, sessions });
  });

  app.get('/api/v1/sessions/:sessionId/ledger', async (req, res) => {
    try {
      const sessionId = resolveSystemSessionId(sessionManager, req.params.sessionId);
      const session = sessionManager.getSession(sessionId);
      const storageDir = sessionManager.resolveSessionStorageDir(sessionId);

      // If session metadata is missing, still try to resolve by ledger scan
      let resolvedStorageDir = storageDir;
      let resolvedAgentId = 'finger-system-agent';
      if (!resolvedStorageDir) {
        const systemDir = join(FINGER_PATHS.home, 'system', 'sessions', sessionId);
        const projectDir = join(FINGER_PATHS.sessions.dir, sessionId);
        if (existsSync(systemDir)) resolvedStorageDir = systemDir;
        else if (existsSync(projectDir)) resolvedStorageDir = projectDir;
      }

      if (!resolvedStorageDir) {
        res.status(404).json({ error: 'Storage dir not found' });
        return;
      }

      if (session?.context && typeof session.context.ownerAgentId === 'string') {
        resolvedAgentId = session.context.ownerAgentId;
      }

      const ledgerPath = join(resolvedStorageDir, resolvedAgentId, 'main', 'context-ledger.jsonl');
      const compactPath = join(resolvedStorageDir, resolvedAgentId, 'main', 'compact-memory.jsonl');

      const ledgerEntries = safeParseJsonLines(ledgerPath);
      const compactEntries = safeParseJsonLines(compactPath);

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
}
