import { logger } from '../../../core/logger/index.js';
import type { ISessionManager, Session } from '../../../orchestration/session-types.js';
import type {
  ContextBreakdown,
  KernelMetadata,
  PersistedProgressAgentSnapshot,
  PersistedSessionProgressSnapshot,
  ProgressSnapshot,
  ProgressUpdateEvent,
} from './progress-types.js';

/**
 * Progress Store - 唯一 progress/context stats 真源
 *
 * 语义约束：
 * 1. 只接受 kernel_response 写入
 * 2. 缺失字段不能覆盖 last-known-good
 * 3. last-known-good 需要持久化到 session.context，便于 daemon 重启后恢复
 */

const SESSION_PROGRESS_CONTEXT_KEY = 'progressStoreSnapshotV1';

type ProgressSessionManager = Pick<ISessionManager, 'getSession' | 'updateContext'>;

class ProgressStore {
  private sessionProgress: Map<string, ProgressSnapshot> = new Map();
  private log = logger.module('ProgressStore');
  private sessionManager?: ProgressSessionManager;

  setSessionManager(sessionManager?: ProgressSessionManager): void {
    if (!sessionManager) {
      this.sessionManager = undefined;
      return;
    }
    this.sessionManager = sessionManager;
  }

  /**
   * 更新 progress（只接受 kernel_response 来源）
   */
  update(event: ProgressUpdateEvent): void {
    if (event.source !== 'kernel_response') {
      this.log.warn('Rejected non-kernel_response event:', { source: event.source });
      return;
    }

    const key = this.buildKey(event.sessionId, event.agentId);
    const existing = this.get(event.sessionId, event.agentId);
    const mergedKernelMetadata = this.mergeKernelMetadata(existing?.latestKernelMetadata, event.kernelMetadata);
    const mergedContextBreakdown = this.mergeContextBreakdown(existing?.contextBreakdown, event.contextBreakdown);

    const snapshot: ProgressSnapshot = {
      sessionId: event.sessionId,
      agentId: event.agentId,
      projectPath: existing?.projectPath,
      latestKernelMetadata: mergedKernelMetadata,
      previousKernelMetadata: existing?.latestKernelMetadata ?? existing?.previousKernelMetadata,
      contextBreakdown: mergedContextBreakdown,
      recentToolCalls: event.toolCalls ?? existing?.recentToolCalls ?? [],
      status: event.status ?? existing?.status ?? 'idle',
      currentTask: event.currentTask ?? existing?.currentTask,
      latestStepSummary: event.lastTurnSummary ?? existing?.latestStepSummary,
      lastKernelResponseAt: event.timestamp ?? existing?.lastKernelResponseAt,
      lastProgressUpdateAt: new Date(),
      teamStatus: existing?.teamStatus,
      mailboxStatus: existing?.mailboxStatus,
    };

    this.sessionProgress.set(key, snapshot);
    this.persistSnapshot(snapshot);
  }

  /**
   * 获取 progress（用于渲染）
   */
  get(sessionId: string, agentId?: string): ProgressSnapshot | undefined {
    if (agentId) {
      const key = this.buildKey(sessionId, agentId);
      const existing = this.sessionProgress.get(key);
      if (existing) return existing;
      return this.hydrateFromSessionContext(sessionId, agentId);
    }

    for (const [key, snapshot] of this.sessionProgress.entries()) {
      if (key.startsWith(`${sessionId}::`)) {
        return snapshot;
      }
    }

    return this.hydrateFromSessionContext(sessionId);
  }

  /**
   * 获取 kernel metadata（优先最新，兜底用上一轮）
   */
  getKernelMetadata(sessionId: string, agentId?: string): ProgressSnapshot['latestKernelMetadata'] | undefined {
    const snapshot = this.get(sessionId, agentId);
    if (!snapshot) return undefined;

    if (snapshot.latestKernelMetadata) return snapshot.latestKernelMetadata;
    return snapshot.previousKernelMetadata;
  }

  /**
   * 清除 session progress
   */
  clear(sessionId: string): void {
    for (const key of this.sessionProgress.keys()) {
      if (key.startsWith(`${sessionId}::`)) {
        this.sessionProgress.delete(key);
      }
    }
    this.persistClearedSession(sessionId);
  }

  /**
   * 更新团队状态
   */
  updateTeamStatus(sessionId: string, teamStatus: ProgressSnapshot['teamStatus']): void {
    for (const [key, snapshot] of this.sessionProgress.entries()) {
      if (!key.startsWith(`${sessionId}::`)) continue;
      snapshot.teamStatus = teamStatus;
    }
  }

  /**
   * 更新 mailbox 状态
   */
  updateMailboxStatus(sessionId: string, agentId: string, mailboxStatus: ProgressSnapshot['mailboxStatus']): void {
    const snapshot = this.get(sessionId, agentId);
    if (!snapshot) return;
    snapshot.mailboxStatus = mailboxStatus;
  }

  private buildKey(sessionId: string, agentId: string): string {
    return `${sessionId}::${agentId}`;
  }

  private mergeKernelMetadata(
    existing?: KernelMetadata,
    incoming?: KernelMetadata,
  ): KernelMetadata | undefined {
    const merged: KernelMetadata = {};
    const apply = (source?: KernelMetadata) => {
      if (!source) return;
      for (const field of ProgressStore.KERNEL_METADATA_FIELDS) {
        const value = this.normalizeOptionalInt(source[field]);
        if (value !== undefined) {
          merged[field] = value;
        }
      }
    };

    apply(existing);
    apply(incoming);
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  private mergeContextBreakdown(
    existing?: ContextBreakdown,
    incoming?: ContextBreakdown,
  ): ContextBreakdown | undefined {
    const merged: ContextBreakdown = {} as ContextBreakdown;
    const apply = (source?: ContextBreakdown) => {
      if (!source) return;
      for (const field of ProgressStore.CONTEXT_BREAKDOWN_FIELDS) {
        const value = this.normalizeOptionalInt(source[field]);
        if (value !== undefined) {
          merged[field] = value;
        }
      }
    };

    apply(existing);
    apply(incoming);
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  private normalizeOptionalInt(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : undefined;
  }

  private persistSnapshot(snapshot: ProgressSnapshot): void {
    if (!this.sessionManager?.updateContext) return;

    const persisted = this.readPersistedSessionSnapshot(snapshot.sessionId) ?? {
      version: 1,
      byAgent: {},
    };
    persisted.byAgent[snapshot.agentId] = this.serializeSnapshot(snapshot);

    const ok = this.sessionManager.updateContext(snapshot.sessionId, {
      [SESSION_PROGRESS_CONTEXT_KEY]: persisted,
    });
    if (!ok) {
      this.log.debug('Skipped persisting progress snapshot because session context update failed', {
        sessionId: snapshot.sessionId,
        agentId: snapshot.agentId,
      });
    }
  }

  private persistClearedSession(sessionId: string): void {
    if (!this.sessionManager?.updateContext) return;
    const session = this.safeGetSession(sessionId);
    if (!session) return;
    const context = this.isObjectRecord(session.context) ? session.context : {};
    if (!this.isObjectRecord(context[SESSION_PROGRESS_CONTEXT_KEY])) return;

    const ok = this.sessionManager.updateContext(sessionId, {
      [SESSION_PROGRESS_CONTEXT_KEY]: {
        version: 1,
        byAgent: {},
      } satisfies PersistedSessionProgressSnapshot,
    });
    if (!ok) {
      this.log.debug('Failed to clear persisted progress snapshot', { sessionId });
    }
  }

  private hydrateFromSessionContext(sessionId: string, agentId?: string): ProgressSnapshot | undefined {
    const persisted = this.readPersistedSessionSnapshot(sessionId);
    if (!persisted) return undefined;

    if (agentId) {
      const hydrated = this.deserializeAgentSnapshot(sessionId, agentId, persisted.byAgent[agentId]);
      if (hydrated) {
        this.sessionProgress.set(this.buildKey(sessionId, agentId), hydrated);
      }
      return hydrated;
    }

    const firstAgentEntry = Object.entries(persisted.byAgent)[0];
    if (!firstAgentEntry) return undefined;
    const [firstAgentId, raw] = firstAgentEntry;
    const hydrated = this.deserializeAgentSnapshot(sessionId, firstAgentId, raw);
    if (hydrated) {
      this.sessionProgress.set(this.buildKey(sessionId, firstAgentId), hydrated);
    }
    return hydrated;
  }

  private deserializeAgentSnapshot(
    sessionId: string,
    agentId: string,
    raw?: PersistedProgressAgentSnapshot,
  ): ProgressSnapshot | undefined {
    if (!raw) return undefined;
    const latestKernelMetadata = this.mergeKernelMetadata(undefined, raw.latestKernelMetadata);
    const previousKernelMetadata = this.mergeKernelMetadata(undefined, raw.previousKernelMetadata);
    const contextBreakdown = this.mergeContextBreakdown(undefined, raw.contextBreakdown);

    if (!latestKernelMetadata && !previousKernelMetadata && !contextBreakdown) {
      return undefined;
    }

    return {
      sessionId,
      agentId,
      latestKernelMetadata,
      previousKernelMetadata,
      contextBreakdown,
      recentToolCalls: [],
      status: 'idle',
      lastKernelResponseAt: this.parseDate(raw.lastKernelResponseAt),
      lastProgressUpdateAt: this.parseDate(raw.lastProgressUpdateAt),
    };
  }

  private serializeSnapshot(snapshot: ProgressSnapshot): PersistedProgressAgentSnapshot {
    return {
      latestKernelMetadata: this.mergeKernelMetadata(undefined, snapshot.latestKernelMetadata),
      previousKernelMetadata: this.mergeKernelMetadata(undefined, snapshot.previousKernelMetadata),
      contextBreakdown: this.mergeContextBreakdown(undefined, snapshot.contextBreakdown),
      lastKernelResponseAt: snapshot.lastKernelResponseAt?.toISOString(),
      lastProgressUpdateAt: snapshot.lastProgressUpdateAt?.toISOString(),
    };
  }

  private readPersistedSessionSnapshot(sessionId: string): PersistedSessionProgressSnapshot | undefined {
    const session = this.safeGetSession(sessionId);
    if (!session || !this.isObjectRecord(session.context)) return undefined;
    const raw = session.context[SESSION_PROGRESS_CONTEXT_KEY];
    if (!this.isObjectRecord(raw)) return undefined;
    if (raw.version !== 1 || !this.isObjectRecord(raw.byAgent)) return undefined;

    const byAgent: PersistedSessionProgressSnapshot['byAgent'] = {};
    for (const [agentId, value] of Object.entries(raw.byAgent)) {
      if (!this.isObjectRecord(value)) continue;
      byAgent[agentId] = {
        latestKernelMetadata: this.isObjectRecord(value.latestKernelMetadata)
          ? (value.latestKernelMetadata as KernelMetadata)
          : undefined,
        previousKernelMetadata: this.isObjectRecord(value.previousKernelMetadata)
          ? (value.previousKernelMetadata as KernelMetadata)
          : undefined,
        contextBreakdown: this.isObjectRecord(value.contextBreakdown)
          ? (value.contextBreakdown as unknown as ContextBreakdown)
          : undefined,
        lastKernelResponseAt: typeof value.lastKernelResponseAt === 'string' ? value.lastKernelResponseAt : undefined,
        lastProgressUpdateAt: typeof value.lastProgressUpdateAt === 'string' ? value.lastProgressUpdateAt : undefined,
      };
    }

    return {
      version: 1,
      byAgent,
    };
  }

  private safeGetSession(sessionId: string): Session | null {
    if (!this.sessionManager?.getSession) return null;
    try {
      return this.sessionManager.getSession(sessionId) ?? null;
    } catch (error) {
      this.log.debug('Failed to read session for progress hydration', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private parseDate(value: string | undefined): Date | undefined {
    if (typeof value !== 'string' || value.trim().length === 0) return undefined;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms) : undefined;
  }

  private isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private static readonly KERNEL_METADATA_FIELDS: Array<keyof KernelMetadata> = [
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'context_window',
    'history_items_count',
    'round',
    'seq',
    'context_usage_percent',
    'estimated_tokens_in_context_window',
  ];

  private static readonly CONTEXT_BREAKDOWN_FIELDS: Array<keyof ContextBreakdown> = [
    'historyDigestTokens',
    'currentFullTokens',
    'systemPromptTokens',
    'developerInstructionsTokens',
    'totalTokens',
    'maxInputTokens',
  ];
}

export const progressStore = new ProgressStore();
export { SESSION_PROGRESS_CONTEXT_KEY };
