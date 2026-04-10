import type { RuntimeEvent } from '../../runtime/events.js';
import type { AgentInfo, TaskContext, SubscriptionLevel, WrappedStatusUpdate } from './agent-status-subscriber-types.js';

export function getAgentIcon(role?: string): string {
  const icons: Record<string, string> = {
    orchestrator: '🎯',
    executor: '⚡',
    
    searcher: '🔎',
  };
  return icons[role || ''] || '🤖';
}

export function wrapStatusUpdate(
  event: RuntimeEvent,
  payload: any,
  agentInfo: AgentInfo,
  taskContext: TaskContext,
  level: SubscriptionLevel
): WrappedStatusUpdate {
  const statusMap: Record<string, WrappedStatusUpdate['status']['state']> = {
    running: 'running',
    idle: 'completed',
    error: 'failed',
    paused: 'paused',
    waiting_input: 'waiting',
    completed: 'completed',
    failed: 'failed',
  };

  const state = statusMap[payload.status] || 'running';

  const update: WrappedStatusUpdate = {
    type: 'agent_status',
    eventId: `evt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    timestamp: event.timestamp,
    sessionId: event.sessionId,
    task: taskContext,
    agent: agentInfo,
    status: {
      state,
      summary: payload.summary || `${agentInfo.agentName || agentInfo.agentId} ${state}`,
    },
    display: {
      title: `${agentInfo.agentName || agentInfo.agentId} 任务状态`,
      subtitle: taskContext.taskDescription || payload.summary,
      icon: getAgentIcon(agentInfo.agentRole),
      level,
    },
  };

  if (level === 'detailed') {
    update.status.details = {
      rawStatus: payload.status,
      scope: payload.scope,
    };
  }

  return update;
}
