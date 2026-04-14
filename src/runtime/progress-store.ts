import { logger } from '../core/logger.js';
import type { ProgressSnapshot, ProgressUpdateEvent, KernelMetadata } from './progress-types.js';

const log = logger.module('ProgressStore');

class SessionProgressStore {
  private snapshots = new Map<string, ProgressSnapshot>();
  private historyMetadata = new Map<string, KernelMetadata[]>();

  updateFromKernelResponse(sessionId: string, agentId: string, event: ProgressUpdateEvent): void {
    if (event.source !== 'kernel_response') { log.warn('Rejected non-kernel_response source', { sessionId, source: event.source }); return; }
    const now = Date.now();
    const existing = this.snapshots.get(sessionId);
    const snapshot: ProgressSnapshot = {
      sessionId, agentId, timestamp: now, timestamp_iso: new Date(now).toISOString(),
      kernelMetadata: event.kernelMetadata ?? existing?.kernelMetadata ?? null,
      contextBreakdown: event.contextBreakdown ?? existing?.contextBreakdown ?? null,
      toolCalls: event.toolCalls ?? existing?.toolCalls ?? [],
      pendingTool: existing?.pendingTool ?? null,
      lastTurnSummary: event.lastTurnSummary ?? existing?.lastTurnSummary ?? '',
      recentRounds: existing?.recentRounds ?? [],
      internalState: event.internalState ?? existing?.internalState ?? '启动中',
      internalStateDuration: existing?.internalStateDuration ?? 0,
      externalState: event.externalState ?? existing?.externalState ?? '',
      externalStateDuration: existing?.externalStateDuration ?? 0,
      mailboxStatus: existing?.mailboxStatus ?? { unread: 0, pending: 0, processing: 0 },
      teamStatus: existing?.teamStatus ?? { agents: [] },
      contextUsagePercent: this.calculateContextUsage(event.kernelMetadata ?? existing?.kernelMetadata ?? null),
    };
    this.snapshots.set(sessionId, snapshot);
    if (event.kernelMetadata) {
      const h = this.historyMetadata.get(sessionId) ?? [];
      h.push(event.kernelMetadata);
      if (h.length > 10) h.shift();
      this.historyMetadata.set(sessionId, h);
    }
    log.debug('Progress updated', { sessionId, agentId, hasKernelMetadata: !!event.kernelMetadata, contextUsagePercent: snapshot.contextUsagePercent });
  }

  getSnapshot(sessionId: string): ProgressSnapshot | null { return this.snapshots.get(sessionId) ?? null; }

  getLatestUsage(sessionId: string): KernelMetadata | null {
    const s = this.snapshots.get(sessionId);
    if (s?.kernelMetadata) return s.kernelMetadata;
    const h = this.historyMetadata.get(sessionId);
    return h?.length ? h[h.length - 1] : null;
  }

  private calculateContextUsage(metadata: KernelMetadata | null): number {
    if (!metadata) return 0;
    return Math.round(((metadata.total_tokens ?? 0) / (metadata.context_window ?? 262144)) * 100);
  }

  clearSession(sessionId: string): void { this.snapshots.delete(sessionId); this.historyMetadata.delete(sessionId); }
  getAllSnapshots(): Map<string, ProgressSnapshot> { return this.snapshots; }
}

export const progressStore = new SessionProgressStore();
export function updateProgressFromKernel(event: ProgressUpdateEvent): void { progressStore.updateFromKernelResponse(event.sessionId, event.agentId, event); }
export function getProgress(sessionId: string): ProgressSnapshot | null { return progressStore.getSnapshot(sessionId); }
export function getLatestUsage(sessionId: string): KernelMetadata | null { return progressStore.getLatestUsage(sessionId); }
