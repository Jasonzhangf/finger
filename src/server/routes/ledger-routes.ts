/**
 * Ledger read-only API routes
 * Exposes ledger data for UI inspection (slot browsing, jump-to-slot)
 */

import type { Express } from 'express';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { SessionManager } from '../../orchestration/session-manager.js';

interface LedgerRouteDeps {
  sessionManager: SessionManager;
}

function resolveSystemSessionId(sessionManager: SessionManager, sessionId: string): string {
  if (sessionId === 'system-default-session') {
    return sessionManager.getOrCreateSystemSession().id;
  }
  return sessionId;
}

export function registerLedgerRoutes(app: Express, deps: LedgerRouteDeps): void {
  const { sessionManager } = deps;

  app.get('/api/v1/sessions/:sessionId/ledger', async (req, res) => {
    try {
      const sessionId = resolveSystemSessionId(sessionManager, req.params.sessionId);
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const storageDir = sessionManager.resolveSessionStorageDir(sessionId);
      if (!storageDir) {
        res.status(404).json({ error: 'Storage dir not found' });
        return;
      }
      const ctx = session.context ?? {};
      const agentId = typeof ctx.ownerAgentId === 'string' ? ctx.ownerAgentId : 'finger-system-agent';
      const ledgerPath = join(storageDir, agentId, 'main', 'context-ledger.jsonl');
      const compactPath = join(storageDir, agentId, 'main', 'compact-memory.jsonl');

      let ledgerEntries: Array<Record<string, unknown>> = [];
      let compactEntries: Array<Record<string, unknown>> = [];

      try {
        if (existsSync(ledgerPath)) {
          const raw = readFileSync(ledgerPath, 'utf-8');
          ledgerEntries = raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        }
      } catch { /* ignore */ }
      try {
        if (existsSync(compactPath)) {
          const raw = readFileSync(compactPath, 'utf-8');
          compactEntries = raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        }
      } catch { /* ignore */ }

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
          id: session.id,
          name: session.name,
          projectPath: session.projectPath,
          totalTokens: session.totalTokens,
          originalStartIndex: session.originalStartIndex,
          originalEndIndex: session.originalEndIndex,
          latestCompactIndex: session.latestCompactIndex,
        },
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
