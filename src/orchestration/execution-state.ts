/**
 * Execution State Persistence - 执行状态持久化（唯一真源）
 *
 * 用途：
 * - 记录每个 session 的 in-flight dispatch 状态
 * - 用于 daemon 重启后判定哪些 session 需要恢复
 *
 * 落盘位置：
 * - ~/.finger/sessions/<session-root>/main/execution-state.json
 *
 * 恢复规则：
 * - recoverable = session(type=durable) AND has in-flight dispatch(es)
 * - review/ephemeral/heartbeat 不参与恢复
 */

import fs from 'fs';
import path from 'path';
import { FINGER_PATHS } from '../core/finger-paths.js';
import { logger } from '../core/logger.js';

const log = logger.module('ExecutionState');

export interface InFlightDispatch {
  dispatchId: string;
  sessionId: string;
  sourceAgentId: string;
  targetAgentId: string;
  startedAt: string;
  status: 'in-flight' | 'completed' | 'failed' | 'abandoned';
  lifecycleStage?: string;
  workerId?: string;
}

export interface ExecutionState {
  sessionId: string;
  dispatches: InFlightDispatch[];
  updatedAt: string;
}

const DEFAULT_STATE: ExecutionState = {
  sessionId: '',
  dispatches: [],
  updatedAt: new Date().toISOString(),
};

function resolveExecutionStatePath(sessionDir: string): string {
  return path.join(sessionDir, 'main', 'execution-state.json');
}

export function loadExecutionState(sessionDir: string): ExecutionState {
  const filePath = resolveExecutionStatePath(sessionDir);
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_STATE };
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Partial<ExecutionState>;
    return {
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
      dispatches: Array.isArray(parsed.dispatches) ? parsed.dispatches : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveExecutionState(sessionDir: string, state: ExecutionState): void {
  const filePath = resolveExecutionStatePath(sessionDir);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

export function markDispatchInFlight(
  sessionDir: string,
  dispatch: {
    dispatchId: string;
    sessionId: string;
    sourceAgentId: string;
    targetAgentId: string;
    workerId?: string;
  },
): void {
  const state = loadExecutionState(sessionDir);
  state.sessionId = dispatch.sessionId;
  state.dispatches = state.dispatches.filter((d) => d.dispatchId !== dispatch.dispatchId);
  state.dispatches.push({
    ...dispatch,
    startedAt: new Date().toISOString(),
    status: 'in-flight',
  });
  saveExecutionState(sessionDir, state);
}

export function markDispatchCompleted(sessionDir: string, dispatchId: string, status: 'completed' | 'failed' = 'completed'): void {
  const state = loadExecutionState(sessionDir);
  const entry = state.dispatches.find((d) => d.dispatchId === dispatchId);
  if (entry) {
    entry.status = status;
    saveExecutionState(sessionDir, state);
  }
}

export function hasInFlightDispatches(sessionDir: string): boolean {
  const state = loadExecutionState(sessionDir);
  return state.dispatches.some((d) => d.status === 'in-flight');
}

export function getInFlightDispatches(sessionDir: string): InFlightDispatch[] {
  const state = loadExecutionState(sessionDir);
  return state.dispatches.filter((d) => d.status === 'in-flight');
}

export function findSessionsWithInFlightDispatches(): Array<{ sessionDir: string; sessionId: string; dispatches: InFlightDispatch[] }> {
  const sessionsDir = FINGER_PATHS.sessions.dir;
  if (!fs.existsSync(sessionsDir)) return [];

  const results: Array<{ sessionDir: string; sessionId: string; dispatches: InFlightDispatch[] }> = [];
  const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(sessionsDir, entry.name);
    const subEntries = fs.readdirSync(projectDir, { withFileTypes: true });
    
    for (const sub of subEntries) {
      if (!sub.isDirectory()) continue;
      const subPath = path.join(projectDir, sub.name);
      if (sub.name.startsWith('session-review-') || sub.name.startsWith('review-')) continue;
      if (!fs.existsSync(path.join(subPath, 'main'))) continue;

      const state = loadExecutionState(subPath);
      const inFlight = state.dispatches.filter((d) => d.status === 'in-flight');
      if (inFlight.length > 0) {
        results.push({
          sessionDir: subPath,
          sessionId: state.sessionId || sub.name,
          dispatches: inFlight,
        });
      }
    }
  }

  return results;
}
