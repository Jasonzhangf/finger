import type {
  AgentRoundInfo,
  AgentRuntime,
  ExecutionRound,
  RoundEdgeInfo,
  TaskNode,
  WorkflowInfo,
} from '../api/types.js';
import { DEFAULT_CHAT_AGENT_ID } from './useWorkflowExecution.constants.js';
import type { SessionLog } from './useWorkflowExecution.types.js';

export function inferAgentType(agentId: string): AgentRuntime['type'] {
  if (agentId.includes('orchestrator')) return 'orchestrator';
  if (agentId.includes('reviewer')) return 'reviewer';
  return 'executor';
}

export function inferAgentStatus(log: SessionLog): AgentRuntime['status'] {
  if (!log.endTime) return 'running';
  if (log.success) return 'idle';
  return 'error';
}

function mapTaskStatusToPathStatus(status: TaskNode['status']): 'active' | 'completed' | 'error' | 'pending' {
  if (status === 'in_progress') return 'active';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'error';
  return 'pending';
}

export function pickWorkflowForSession(
  workflows: WorkflowInfo[],
  sessionId: string,
  preferredWorkflowId?: string,
): WorkflowInfo | null {
  if (workflows.length === 0) return null;

  if (preferredWorkflowId) {
    const exact = workflows.find((w) => w.id === preferredWorkflowId || w.epicId === preferredWorkflowId);
    if (exact) return exact;
  }

  const sameSession = workflows.filter((w) => w.sessionId === sessionId);
  const candidates = sameSession.length > 0 ? sameSession : workflows;

  const active = candidates
    .filter((w) => w.status === 'planning' || w.status === 'executing' || w.status === 'paused')
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  if (active.length > 0) return active[0];

  return candidates
    .slice()
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ?? null;
}

export function computeAgentLoadFromLog(log: SessionLog): number {
  const rounds = Math.max(log.totalRounds || log.iterations.length || 1, 1);
  const current = log.iterations.length;
  if (log.endTime) return 100;
  return Math.min(95, Math.max(5, Math.round((current / rounds) * 100)));
}

export function buildRoundExecutionPath(
  tasks: TaskNode[],
  orchestratorId: string,
): Array<{ from: string; to: string; status: 'active' | 'completed' | 'error' | 'pending'; message: string }> {
  return tasks.map((task) => ({
    from: orchestratorId,
    to: task.assignee || orchestratorId,
    status: mapTaskStatusToPathStatus(task.status),
    message: `${task.id}: ${task.description}`,
  }));
}

export function buildExecutionRoundsFromTasks(tasks: TaskNode[]): ExecutionRound[] {
  const roundMap = new Map<string, ExecutionRound>();

  for (const task of tasks) {
    const roundKey = `round-${task.id.split('-')[0] || '0'}`;
    if (!roundMap.has(roundKey)) {
      roundMap.set(roundKey, {
        roundId: roundKey,
        timestamp: task.startedAt || new Date().toISOString(),
        agents: [],
        edges: [],
      });
    }

    const round = roundMap.get(roundKey)!;
    const agentInfo: AgentRoundInfo = {
      agentId: task.assignee || DEFAULT_CHAT_AGENT_ID,
      status: task.status === 'completed'
        ? 'completed'
        : task.status === 'failed'
          ? 'error'
          : task.status === 'in_progress'
            ? 'running'
            : 'idle',
      taskId: task.id,
      taskDescription: task.description,
    };
    if (!round.agents.some((a) => a.agentId === agentInfo.agentId)) {
      round.agents.push(agentInfo);
    }

    const edgeInfo: RoundEdgeInfo = {
      from: DEFAULT_CHAT_AGENT_ID,
      to: task.assignee || DEFAULT_CHAT_AGENT_ID,
      status: task.status === 'completed'
        ? 'completed'
        : task.status === 'failed'
          ? 'error'
          : task.status === 'in_progress'
            ? 'active'
            : 'pending',
      message: `${task.id}: ${task.description.slice(0, 32)}`,
    };
    if (!round.edges.some((e) => e.to === edgeInfo.to && e.from === edgeInfo.from)) {
      round.edges.push(edgeInfo);
    }
  }

  return Array.from(roundMap.values()).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}
