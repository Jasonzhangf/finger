import { logger } from '../../../core/logger.js';
import { isObjectRecord } from '../../common/object.js';
import { getGlobalDispatchTracker } from './dispatch-tracker.js';
import type { AgentControlRequest, AgentControlResult, AgentRuntimeDeps } from './types.js';

const log = logger.module('AgentRuntimeControl');

function extractSessionIdFromResult(result: AgentControlResult): string | undefined {
  if (typeof result.sessionId === 'string' && result.sessionId.trim().length > 0) {
    return result.sessionId.trim();
  }
  if (!isObjectRecord(result.result)) return undefined;
  const sessionId = result.result.sessionId;
  return typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : undefined;
}

async function cascadeInterruptChildren(
  deps: AgentRuntimeDeps,
  parentSessionId: string,
  action: 'interrupt' | 'cancel',
  providerId?: string,
): Promise<{ interrupted: string[]; failed: Array<{ sessionId: string; error: string }> }> {
  const tracker = getGlobalDispatchTracker();
  const visited = new Set<string>([parentSessionId]);
  const queue = [parentSessionId];
  const interrupted: string[] = [];
  const failed: Array<{ sessionId: string; error: string }> = [];

  while (queue.length > 0) {
    const current = queue.shift()!;

    const trackerChildren = tracker.getActiveChildSessionIds(current);
    const contextChildren = deps.sessionManager
      .listSessions()
      .filter((session) => {
        if (visited.has(session.id)) return false;
        const context = isObjectRecord(session.context) ? session.context : {};
        const parent = typeof context.parentSessionId === 'string' ? context.parentSessionId : '';
        return parent === current;
      })
      .map((session) => session.id);

    const childSessionIds = Array.from(new Set([...trackerChildren, ...contextChildren]));
    for (const childSessionId of childSessionIds) {
      if (visited.has(childSessionId)) continue;
      visited.add(childSessionId);

      const childResult = await deps.agentRuntimeBlock.execute('control', {
        action,
        sessionId: childSessionId,
        ...(typeof providerId === 'string' && providerId.trim().length > 0 ? { providerId: providerId.trim() } : {}),
      } as Record<string, unknown>) as AgentControlResult;

      if (childResult.ok) {
        interrupted.push(childSessionId);
        queue.push(childSessionId);
      } else {
        failed.push({ sessionId: childSessionId, error: childResult.error ?? 'unknown error' });
      }

      // Mark tracked dispatches complete to prevent stale active-child states
      for (const record of tracker.getAllRecords()) {
        if (record.childSessionId === childSessionId && !record.completed) {
          tracker.complete(record.dispatchId);
        }
      }
    }
  }

  return { interrupted, failed };
}

export async function controlAgentRuntime(
  deps: AgentRuntimeDeps,
  input: AgentControlRequest,
): Promise<AgentControlResult> {
  const result = await deps.agentRuntimeBlock.execute('control', input as unknown as Record<string, unknown>) as AgentControlResult;

  // System-level interrupt cascade:
  // when a parent session is interrupted/canceled, all active dispatched child sessions are interrupted too.
  if ((input.action === 'interrupt' || input.action === 'cancel') && result.ok) {
    const sessionId = extractSessionIdFromResult(result)
      ?? (typeof input.sessionId === 'string' && input.sessionId.trim().length > 0 ? input.sessionId.trim() : undefined);

    if (sessionId) {
      const cascade = await cascadeInterruptChildren(deps, sessionId, input.action, input.providerId);
      if (cascade.interrupted.length > 0 || cascade.failed.length > 0) {
        log.info('[AgentRuntimeControl] Cascade interrupt completed', {
          rootSessionId: sessionId,
          action: input.action,
          interruptedChildren: cascade.interrupted.length,
          failedChildren: cascade.failed.length,
        });
      }

      const currentResult = isObjectRecord(result.result) ? result.result : {};
      result.result = {
        ...currentResult,
        cascade: {
          interruptedSessionIds: cascade.interrupted,
          failed: cascade.failed,
        },
      };
    }
  }

  return result;
}
