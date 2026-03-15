/**
 * System Agent Events
 *
 * Emit system-level events for UI monitoring.
 */

import type { AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';

export function emitAgentStatusChanged(
  deps: AgentRuntimeDeps,
  payload: { agentId: string; status: string; projectId?: string }
): void {
  deps.broadcast({
    type: 'system_notice',
    payload: {
      source: 'system-agent',
      event: 'agent_status_changed',
      agentId: payload.agentId,
      status: payload.status,
      projectId: payload.projectId,
    },
    timestamp: new Date().toISOString(),
    sessionId: payload.projectId ?? 'system',
  });
}

export function emitTaskCompleted(
  deps: AgentRuntimeDeps,
  payload: { taskId: string; agentId?: string; projectId?: string }
): void {
  deps.broadcast({
    type: 'system_notice',
    payload: {
      source: 'system-agent',
      event: 'task_completed',
      taskId: payload.taskId,
      agentId: payload.agentId,
      projectId: payload.projectId,
    },
    timestamp: new Date().toISOString(),
    sessionId: payload.projectId ?? 'system',
  });
}
