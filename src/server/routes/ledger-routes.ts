/**
 * Ledger read-only API routes
 * Exposes ledger data for UI inspection and ledger-based session listing.
 */

import type { Express } from 'express';
import { dirname } from 'path';
import type { SessionManager } from '../../orchestration/session-manager.js';
import { buildContext } from '../../runtime/context-builder.js';
import { getContextWindow, loadContextBuilderSettings } from '../../core/user-settings.js';
import { listLedgerSessionsSnapshot, resolveLedgerSource } from './ledger-routes-storage.js';
import {
  buildContextMonitorRounds,
  toMonitorEntry,
  type ContextMonitorRound,
  type ContextMonitorSlotEntry,
} from './ledger-routes-context-monitor.js';

interface LedgerRouteDeps {
  sessionManager: SessionManager;
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

  app.get('/api/v1/sessions/:sessionId/context-monitor', async (req, res) => {
    try {
      const resolved = resolveLedgerSource(sessionManager, req.params.sessionId);
      if (!resolved) {
        res.status(404).json({ error: 'Storage dir not found' });
        return;
      }

      const {
        sessionId,
        session,
        resolvedStorageDir,
        resolvedAgentId,
        ledgerEntries,
      } = resolved;

      const requestedLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : 1200;
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(100, Math.min(5000, requestedLimit))
        : 1200;
      const startIndex = Math.max(0, ledgerEntries.length - limit);
      const windowEntries = ledgerEntries.slice(startIndex);
      const slotEntries = windowEntries.map((entry, idx) => toMonitorEntry(entry, startIndex + idx + 1));
      const rounds = buildContextMonitorRounds(slotEntries);

      const contextBuilderSettings = loadContextBuilderSettings();
      const contextWindow = getContextWindow();
      const configuredBudget = Number.isFinite(contextBuilderSettings.historyBudgetTokens)
        && contextBuilderSettings.historyBudgetTokens > 0
        ? Math.floor(contextBuilderSettings.historyBudgetTokens)
        : Math.floor(contextWindow * contextBuilderSettings.budgetRatio);
      const targetBudget = Math.max(1, Math.min(contextWindow, configuredBudget));
      const nowMs = Date.now();

      let contextBuild:
        | {
          ok: true;
          totalTokens: number;
          memoryMdIncluded: boolean;
          taskBlockCount: number;
          filteredTaskBlockCount: number;
          buildTimestamp: string;
          metadata: {
            rawTaskBlockCount: number;
            timeWindowFilteredCount: number;
            budgetTruncatedCount: number;
            budgetTruncatedTasks?: Array<{
              id: string;
              tokenCount: number;
              startTimeIso: string;
              topic?: string;
              tags?: string[];
              summary?: string;
            }>;
            targetBudget: number;
            actualTokens: number;
            workingSetTaskBlockCount?: number;
            historicalTaskBlockCount?: number;
            workingSetMessageCount?: number;
            historicalMessageCount?: number;
            workingSetTokens?: number;
            historicalTokens?: number;
            workingSetBlockIds?: string[];
            historicalBlockIds?: string[];
          };
          messages: Array<{
            id: string;
            role: string;
            content: string;
            timestampIso: string;
            tokenCount: number;
            contextZone?: 'working_set' | 'historical_memory';
          }>;
        }
        | {
          ok: false;
          error: string;
          messages: [];
        };

      try {
        // buildContext expects `rootDir` to be the sessions root directory,
        // and will append `<sessionId>/<agentId>/<mode>/context-ledger.jsonl`.
        // `resolvedStorageDir` here is already the concrete session directory,
        // so we must pass its parent to avoid duplicated session path segments.
        const contextRootDir = dirname(resolvedStorageDir);
        const built = await buildContext(
          {
            rootDir: contextRootDir,
            sessionId,
            agentId: resolvedAgentId,
            mode: 'main',
          },
          {
            targetBudget,
            buildMode: contextBuilderSettings.mode,
            includeMemoryMd: false,
            enableTaskGrouping: true,
            enableModelRanking: contextBuilderSettings.enableModelRanking,
            rankingProviderId: contextBuilderSettings.rankingProviderId,
          },
        );

        contextBuild = {
          ok: true,
          totalTokens: built.totalTokens,
          memoryMdIncluded: built.memoryMdIncluded,
          taskBlockCount: built.taskBlockCount,
          filteredTaskBlockCount: built.filteredTaskBlockCount,
          buildTimestamp: built.buildTimestamp,
          metadata: built.metadata,
          messages: built.messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            timestampIso: message.timestampIso,
            tokenCount: message.tokenCount,
            ...(message.contextZone ? { contextZone: message.contextZone } : {}),
          })),
        };
      } catch (error) {
        contextBuild = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          messages: [],
        };
      }

      const slotByMessageId = new Map<string, number>();
      for (const item of slotEntries) {
        slotByMessageId.set(item.id, item.slot);
      }
      const roundBySlot = (slot: number): ContextMonitorRound | null => {
        for (const round of rounds) {
          if (slot >= round.slotStart && slot <= round.slotEnd) return round;
        }
        return null;
      };

      for (const message of contextBuild.messages) {
        const matchedSlot = slotByMessageId.get(message.id);
        if (!matchedSlot) continue;
        const targetRound = roundBySlot(matchedSlot);
        if (!targetRound) continue;
        targetRound.contextMessages.push({
          id: message.id,
          slot: matchedSlot,
          role: message.role,
          content: message.content,
          timestampIso: message.timestampIso,
          tokenCount: message.tokenCount,
          ...(typeof message.contextZone === 'string' ? { contextZone: message.contextZone } : {}),
        });
      }

      res.json({
        success: true,
        sessionId,
        projectPath: session?.projectPath || '',
        agentId: resolvedAgentId,
        updatedAt: new Date().toISOString(),
        contextBuilder: {
          enabled: contextBuilderSettings.enabled,
          historyBudgetTokens: contextBuilderSettings.historyBudgetTokens,
          budgetRatio: contextBuilderSettings.budgetRatio,
          targetBudget,
          historyOnly: true,
          halfLifeMs: contextBuilderSettings.halfLifeMs,
          includeMemoryMd: false,
          enableModelRanking: contextBuilderSettings.enableModelRanking,
          rankingProviderId: contextBuilderSettings.rankingProviderId,
          mode: contextBuilderSettings.mode,
        },
        contextBuild,
        slotWindow: {
          total: ledgerEntries.length,
          start: slotEntries[0]?.slot ?? 0,
          end: slotEntries[slotEntries.length - 1]?.slot ?? 0,
          limit,
        },
        rounds,
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
