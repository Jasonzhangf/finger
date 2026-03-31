/**
 * Dispatch Tracker
 *
 * 追踪 dispatch 关系，实现系统级中断级联：
 * - 记录 parentSessionId → childSessionId 的映射
 * - 当 system agent 被中断时，级联中断所有子 session
 * - 支持 broadcast 级联中断（从任意 parent 中断）
 */

import { logger } from '../../../core/logger.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type { SessionManager } from '../../../orchestration/session-manager.js';
import { FINGER_PATHS } from '../../../core/finger-paths.js';

const log = logger.module('DispatchTracker');

interface DispatchRecord {
  dispatchId: string;
  parentSessionId: string;
  childSessionId: string;
  sourceAgentId: string;
  targetAgentId: string;
  dispatchedAt: number;
  completed: boolean;
  completedAt?: number;
}

interface DispatchTrackerFile {
  version: '1.0.0';
  records: DispatchRecord[];
}

const DEFAULT_DISPATCH_TRACKER_PATH = path.join(FINGER_PATHS.runtime.schedulesDir, 'dispatch-graph.json');

export class DispatchTracker {
  private readonly records = new Map<string, DispatchRecord>();
  private readonly byParentSession = new Map<string, Set<string>>();
  private readonly byChildSession = new Map<string, string>();
  private readonly filePath: string;

  constructor(filePath = DEFAULT_DISPATCH_TRACKER_PATH) {
    this.filePath = filePath;
    this.loadFromDisk();
  }

  getPath(): string {
    return this.filePath;
  }

  track(record: {
    dispatchId: string;
    parentSessionId: string;
    childSessionId: string;
    sourceAgentId: string;
    targetAgentId: string;
  }): void {
    const entry: DispatchRecord = {
      ...record,
      dispatchedAt: Date.now(),
      completed: false,
    };
    this.records.set(record.dispatchId, entry);

    let parentSet = this.byParentSession.get(record.parentSessionId);
    if (!parentSet) {
      parentSet = new Set();
      this.byParentSession.set(record.parentSessionId, parentSet);
    }
    parentSet.add(record.dispatchId);

    this.byChildSession.set(record.childSessionId, record.dispatchId);
    this.persistToDisk();

    log.debug('[DispatchTracker] Tracked dispatch', {
      dispatchId: record.dispatchId,
      parent: record.parentSessionId,
      child: record.childSessionId,
      source: record.sourceAgentId,
      target: record.targetAgentId,
    });
  }

  complete(dispatchId: string): void {
    const record = this.records.get(dispatchId);
    if (record) {
      record.completed = true;
      record.completedAt = Date.now();
      this.persistToDisk();
    }
  }

  /** 获取所有与指定 sessionId 关联的活跃子 sessionId */
  getActiveChildSessionIds(sessionId: string): string[] {
    const dispatchIds = this.byParentSession.get(sessionId);
    if (!dispatchIds || dispatchIds.size === 0) return [];

    const activeChildIds: string[] = [];
    for (const dispatchId of dispatchIds) {
      const record = this.records.get(dispatchId);
      if (record && !record.completed) {
        activeChildIds.push(record.childSessionId);
      }
    }
    return activeChildIds;
  }

  /** 获取指定 childSession 对应的 parentSessionId */
  getParentSessionId(childSessionId: string): string | undefined {
    const dispatchId = this.byChildSession.get(childSessionId);
    if (!dispatchId) return undefined;
    return this.records.get(dispatchId)?.parentSessionId;
  }

  /** 检查 sessionId 是否有活跃的 dispatch 子任务 */
  hasActiveChildren(sessionId: string): boolean {
    return this.getActiveChildSessionIds(sessionId).length > 0;
  }

  /** 获取所有 dispatch 记录（调试用） */
  getAllRecords(): DispatchRecord[] {
    return Array.from(this.records.values());
  }

  /** 获取指定 session 的 dispatch 统计 */
  getSessionStats(sessionId: string): { active: number; completed: number; total: number } {
    const dispatchIds = this.byParentSession.get(sessionId);
    if (!dispatchIds) return { active: 0, completed: 0, total: 0 };

    let active = 0;
    let completed = 0;
    for (const dispatchId of dispatchIds) {
      const record = this.records.get(dispatchId);
      if (record) {
        if (record.completed) completed++;
        else active++;
      }
    }
    return { active, completed, total: dispatchIds.size };
  }

  /** 清理已完成的旧记录（保留最近 N 分钟的记录） */
  cleanup(maxAgeMs: number = 3600_000): number {
    const now = Date.now();
    let removed = 0;
    for (const [dispatchId, record] of this.records) {
      if (record.completed && record.completedAt && (now - record.completedAt) > maxAgeMs) {
        const parentSet = this.byParentSession.get(record.parentSessionId);
        if (parentSet) {
          parentSet.delete(dispatchId);
          if (parentSet.size === 0) this.byParentSession.delete(record.parentSessionId);
        }
        const mappedDispatchId = this.byChildSession.get(record.childSessionId);
        if (mappedDispatchId === dispatchId) this.byChildSession.delete(record.childSessionId);
        this.records.delete(dispatchId);
        removed++;
      }
    }
    if (removed > 0) this.persistToDisk();
    return removed;
  }

  private loadFromDisk(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
      const file = this.parseFile(parsed);
      for (const record of file.records) {
        this.records.set(record.dispatchId, record);
        let parentSet = this.byParentSession.get(record.parentSessionId);
        if (!parentSet) {
          parentSet = new Set();
          this.byParentSession.set(record.parentSessionId, parentSet);
        }
        parentSet.add(record.dispatchId);
        this.byChildSession.set(record.childSessionId, record.dispatchId);
      }
    } catch (error) {
      log.warn('[DispatchTracker] Failed to load persisted dispatch graph, fallback to empty tracker', {
        filePath: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private persistToDisk(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const file: DispatchTrackerFile = {
        version: '1.0.0',
        records: Array.from(this.records.values())
          .sort((a, b) => b.dispatchedAt - a.dispatchedAt)
          .slice(0, 4000),
      };
      writeFileSync(this.filePath, JSON.stringify(file, null, 2), 'utf8');
    } catch (error) {
      log.warn('[DispatchTracker] Failed to persist dispatch graph', {
        filePath: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private parseFile(value: unknown): DispatchTrackerFile {
    if (
      typeof value !== 'object'
      || value === null
      || !Array.isArray((value as { records?: unknown }).records)
    ) {
      return { version: '1.0.0', records: [] };
    }
    const records: DispatchRecord[] = [];
    for (const item of (value as { records: unknown[] }).records) {
      if (typeof item !== 'object' || item === null) continue;
      const raw = item as Record<string, unknown>;
      const dispatchId = typeof raw.dispatchId === 'string' ? raw.dispatchId.trim() : '';
      const parentSessionId = typeof raw.parentSessionId === 'string' ? raw.parentSessionId.trim() : '';
      const childSessionId = typeof raw.childSessionId === 'string' ? raw.childSessionId.trim() : '';
      const sourceAgentId = typeof raw.sourceAgentId === 'string' ? raw.sourceAgentId.trim() : '';
      const targetAgentId = typeof raw.targetAgentId === 'string' ? raw.targetAgentId.trim() : '';
      const dispatchedAt = typeof raw.dispatchedAt === 'number' && Number.isFinite(raw.dispatchedAt)
        ? raw.dispatchedAt
        : Date.now();
      if (!dispatchId || !parentSessionId || !childSessionId || !sourceAgentId || !targetAgentId) continue;
      records.push({
        dispatchId,
        parentSessionId,
        childSessionId,
        sourceAgentId,
        targetAgentId,
        dispatchedAt,
        completed: raw.completed === true,
        ...(typeof raw.completedAt === 'number' && Number.isFinite(raw.completedAt)
          ? { completedAt: raw.completedAt }
          : {}),
      });
    }
    return {
      version: '1.0.0',
      records,
    };
  }
}

// 全局单例
let globalTracker: DispatchTracker | null = null;

export function getGlobalDispatchTracker(): DispatchTracker {
  if (!globalTracker) {
    globalTracker = new DispatchTracker();
  }
  return globalTracker;
}

export function resetGlobalDispatchTracker(): void {
  globalTracker = new DispatchTracker();
}

/**
 * 系统级中断级联
 *
 * 给定一个 parentSessionId，递归查找所有活跃的子 session 并中断它们。
 * 中断通过 ChatCodexRunner 的 interruptSession 实现。
 */
export interface CascadeInterruptDeps {
  sessionManager: SessionManager;
  chatCodexRunner: {
    listSessionStates(sessionId?: string, providerId?: string): Array<{ sessionId: string; hasActiveTurn: boolean }>;
    interruptSession(sessionId: string, providerId?: string): Array<{ interrupted: boolean; sessionId: string }>;
  };
  dispatchTracker: DispatchTracker;
}

export async function cascadeInterrupt(
  deps: CascadeInterruptDeps,
  rootSessionId: string,
  options?: { providerId?: string; maxDepth?: number; hard?: boolean },
): Promise<{
  interruptedSessions: string[];
  errors: Array<{ sessionId: string; error: string }>;
}> {
  const { sessionManager, chatCodexRunner, dispatchTracker } = deps;
  const maxDepth = options?.maxDepth ?? 5;
  const providerId = options?.providerId;
  const interruptedSessions: string[] = [];
  const errors: Array<{ sessionId: string; error: string }> = [];

  const visited = new Set<string>();
  const queue: Array<{ sessionId: string; depth: number }> = [
    { sessionId: rootSessionId, depth: 0 },
  ];

  while (queue.length > 0) {
    const { sessionId, depth } = queue.shift()!;
    if (visited.has(sessionId)) continue;
    visited.add(sessionId);

    if (depth > maxDepth) {
      log.warn('[CascadeInterrupt] Max depth reached', { sessionId, depth });
      continue;
    }

    // 中断当前 session
    try {
      const results = chatCodexRunner.interruptSession(sessionId, providerId);
      for (const result of results) {
        if (result.interrupted) {
          interruptedSessions.push(result.sessionId);
          log.info('[CascadeInterrupt] Interrupted session', {
            sessionId: result.sessionId,
            parentSessionId: rootSessionId,
            depth,
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ sessionId, error: message });
      log.error("[CascadeInterrupt] Failed to interrupt session", undefined, { sessionId, error: message });
    }

    // 查找活跃的子 session
    const activeChildIds = dispatchTracker.getActiveChildSessionIds(sessionId);
    for (const childId of activeChildIds) {
      if (!visited.has(childId)) {
        queue.push({ sessionId: childId, depth: depth + 1 });
      }
    }

    // 也检查 sessionManager 中 context.parentSessionId == sessionId 的 session
    try {
      const allSessions = sessionManager.listSessions();
      for (const session of allSessions) {
        const context = (session.context ?? {}) as Record<string, unknown>;
        const parentSid = typeof context.parentSessionId === 'string' ? context.parentSessionId : '';
        const rootSid = typeof context.rootSessionId === 'string' ? context.rootSessionId : '';

        if (parentSid === sessionId || rootSid === sessionId) {
          if (!visited.has(session.id)) {
            queue.push({ sessionId: session.id, depth: depth + 1 });
          }
        }
      }
    } catch (err) {
      log.error('[CascadeInterrupt] Failed to scan sessions', err instanceof Error ? err : undefined);
    }
  }

  // 标记所有关联的 dispatch 为已完成
  const trackedChildIds = dispatchTracker.getActiveChildSessionIds(rootSessionId);
  // 找到这些 child 对应的 dispatchId
  for (const childId of visited) {
    if (childId !== rootSessionId) {
      const records = dispatchTracker.getAllRecords().filter(
        (r) => r.childSessionId === childId && !r.completed,
      );
      for (const record of records) {
        dispatchTracker.complete(record.dispatchId);
      }
    }
  }

  if (interruptedSessions.length > 0) {
    log.info('[CascadeInterrupt] Cascade complete', {
      rootSessionId,
      interrupted: interruptedSessions.length,
      errors: errors.length,
    });
  }

  return { interruptedSessions, errors };
}
