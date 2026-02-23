import { useState, useEffect, useCallback, useRef } from 'react';
import { useWebSocket } from './useWebSocket.js';
import type {
  WorkflowExecutionState,
  WorkflowInfo,
  AgentExecutionDetail,
  WsMessage,
  WorkflowUpdatePayload,
  AgentUpdatePayload,
  TaskReport,
  TaskNode,
  AgentRuntime,
  RuntimeEvent,
  UserInputPayload,
  UserRound,
  ExecutionRound,
  AgentRoundInfo,
  RoundEdgeInfo,
} from '../api/types.js';

interface SessionLog {
  sessionId: string;
  agentId: string;
  agentRole: string;
  userTask: string;
  taskId?: string;
  startTime: string;
  endTime?: string;
  success: boolean;
  iterations: Array<{
    round: number;
    action: string;
    thought?: string;
    params?: Record<string, unknown>;
    observation?: string;
    success: boolean;
    timestamp: string;
    duration?: number;
  }>;
  totalRounds: number;
  finalOutput?: string;
  finalError?: string;
  stopReason?: string;
}

interface UseWorkflowExecutionReturn {
  workflow: WorkflowInfo | null;
  executionState: WorkflowExecutionState | null;
  runtimeEvents: RuntimeEvent[];
  userRounds: UserRound[];
  executionRounds: ExecutionRound[];
  selectedAgentId: string | null;
  setSelectedAgentId: (agentId: string | null) => void;
  isLoading: boolean;
  error: string | null;
  startWorkflow: (userTask: string) => Promise<void>;
  pauseWorkflow: () => Promise<void>;
  resumeWorkflow: () => Promise<void>;
  sendUserInput: (input: UserInputPayload) => Promise<void>;
  getAgentDetail: (agentId: string) => AgentExecutionDetail | null;
  getTaskReport: () => TaskReport | null;
  isConnected: boolean;
}

function inferAgentType(agentId: string): AgentRuntime['type'] {
  if (agentId.includes('orchestrator')) return 'orchestrator';
  if (agentId.includes('reviewer')) return 'reviewer';
  return 'executor';
}

function inferAgentStatus(log: SessionLog): AgentRuntime['status'] {
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

function pickWorkflowForSession(workflows: WorkflowInfo[], sessionId: string, preferredWorkflowId?: string): WorkflowInfo | null {
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

function pushEvent(current: RuntimeEvent[], event: Omit<RuntimeEvent, 'id'>): RuntimeEvent[] {
  const entry: RuntimeEvent = {
    ...event,
    id: `${event.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
  };
  return [...current.slice(-299), entry];
}

function upsertAgentRuntimeEvent(current: RuntimeEvent[], event: Omit<RuntimeEvent, 'id'>): RuntimeEvent[] {
  // 对同一个 agent 的状态事件做就地更新，避免 UI 积压导致卡顿
  if (event.role !== 'agent' || !event.agentId) {
    return pushEvent(current, event);
  }

  const idx = current.findIndex(
    (e) =>
      e.role === 'agent' &&
      e.agentId === event.agentId &&
      e.kind === 'status',
  );

  if (idx >= 0 && event.kind === 'status') {
    const updated = [...current];
    updated[idx] = {
      ...updated[idx],
      ...event,
    } as RuntimeEvent;
    return updated;
  }

  return pushEvent(current, event);
}

function computeAgentLoadFromLog(log: SessionLog): number {
  const rounds = Math.max(log.totalRounds || log.iterations.length || 1, 1);
  const current = log.iterations.length;
  if (log.endTime) return 100;
  return Math.min(95, Math.max(5, Math.round((current / rounds) * 100)));
}

function buildRoundExecutionPath(
  tasks: TaskNode[],
  orchestratorId: string,
): WorkflowExecutionState['executionPath'] {
  return tasks.map((task) => ({
    from: orchestratorId,
    to: task.assignee || 'executor-loop',
    status: mapTaskStatusToPathStatus(task.status),
    message: `${task.id}: ${task.description}`,
  }));
}

export function useWorkflowExecution(sessionId: string): UseWorkflowExecutionReturn {
  const [workflow, setWorkflow] = useState<WorkflowInfo | null>(null);
  const [executionState, setExecutionState] = useState<WorkflowExecutionState | null>(null);
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>([]);
  const [userRounds, setUserRounds] = useState<UserRound[]>([]);
  const [executionRounds, setExecutionRounds] = useState<ExecutionRound[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<SessionLog[]>([]);
  const executionStateRef = useRef<WorkflowExecutionState | null>(null);

  useEffect(() => {
    executionStateRef.current = executionState;
  }, [executionState]);

  const handleWebSocketMessage = useCallback((msg: WsMessage) => {
    if (msg.type === 'workflow_update') {
      const payload = msg.payload as WorkflowUpdatePayload;

      if (payload.taskUpdates && payload.taskUpdates.length > 0) {
        setExecutionRounds(buildExecutionRoundsFromTasks(payload.taskUpdates, executionStateRef.current?.agents || []));
      }
      setExecutionState((prev) => {
        if (!prev || prev.workflowId !== payload.workflowId) return prev;
        return {
          ...prev,
          status: payload.status,
          orchestrator: payload.orchestratorState
            ? {
                ...prev.orchestrator,
                currentRound: payload.orchestratorState.round,
                thought: payload.orchestratorState.thought,
              }
            : prev.orchestrator,
          tasks: payload.taskUpdates || prev.tasks,
          agents: payload.agentUpdates || prev.agents,
          executionPath: payload.executionPath || prev.executionPath,
          userInput: payload.userInput || prev.userInput,
          paused: payload.status === 'paused' ? true : payload.status === 'executing' ? false : prev.paused,
        };
      });
      // workflow_update 只用于状态更新，不再生成会话面板占位消息
      return;
    }

    if (msg.type === 'agent_update') {
      const payload = msg.payload as AgentUpdatePayload;
      setExecutionState((prev) => {
        if (!prev) return prev;
        const updatedAgents = prev.agents.map((agent) =>
          agent.id === payload.agentId
            ? {
                ...agent,
                status: payload.status,
                currentTaskId: payload.currentTaskId,
                load: payload.load,
              }
            : agent,
        );
        // 当新 agent 出现时添加到列表
        if (!updatedAgents.some((agent) => agent.id === payload.agentId)) {
          updatedAgents.push({
            id: payload.agentId,
            name: payload.agentId,
            type: inferAgentType(payload.agentId),
            status: payload.status,
            load: payload.load || 0,
            errorRate: 0,
            requestCount: 0,
            tokenUsage: 0,
            currentTaskId: payload.currentTaskId,
          });
        }
        return { ...prev, agents: updatedAgents };
      });

      setRuntimeEvents((prev) => {
        const event: Omit<RuntimeEvent, 'id'> = {
          role: 'agent',
          agentId: payload.agentId,
          agentName: executionStateRef.current?.agents.find(a => a.id === payload.agentId)?.name ?? payload.agentId,
          kind: payload.step?.thought ? 'thought' : payload.step?.action ? 'action' : 'status',
          content: payload.step?.thought
            ? payload.step.thought
            : payload.step?.action
              ? `${payload.step.action}${payload.step.observation ? ` -> ${payload.step.observation}` : ''}`
            : `状态 ${payload.status}${payload.currentTaskId ? `，任务 ${payload.currentTaskId}` : ''}`,
          timestamp: new Date().toISOString(),
        };
        return upsertAgentRuntimeEvent(prev, event);
      });
    }
  }, []);

  const { isConnected } = useWebSocket(handleWebSocketMessage);

  const refreshRuntimeState = useCallback(async () => {
    try {
      const [workflowsRes, logsRes] = await Promise.all([
        fetch('/api/v1/workflows'),
        fetch('/api/v1/execution-logs'),
      ]);

      if (!workflowsRes.ok || !logsRes.ok) {
        return;
      }

      const workflows = (await workflowsRes.json()) as WorkflowInfo[];
      const logsPayload = (await logsRes.json()) as { success: boolean; logs: SessionLog[] };
      const allLogs = logsPayload.success ? logsPayload.logs : [];
      setLogs(allLogs);

      const preferredWorkflowId = executionStateRef.current?.workflowId || workflow?.id;
      const selectedWorkflow = pickWorkflowForSession(workflows, sessionId, preferredWorkflowId);
      
      // Always set workflow state, even if empty
      setWorkflow(selectedWorkflow);
      
      if (!selectedWorkflow) {
        // No workflow found - show empty state with default orchestrator agent
        setExecutionState({
          workflowId: `empty-${sessionId}`,
          status: 'planning',
          orchestrator: {
            id: 'orchestrator-loop',
            currentRound: 0,
            maxRounds: 10,
          },
          agents: [{
            id: 'orchestrator-loop',
            name: 'orchestrator-loop',
            type: 'orchestrator',
            status: 'idle',
            load: 0,
            errorRate: 0,
            requestCount: 0,
            tokenUsage: 0,
          }],
          tasks: [],
          executionPath: [],
          paused: false,
          executionRounds: [],
        });
        return;
      }

      const tasksRes = await fetch(`/api/v1/workflows/${selectedWorkflow.id}/tasks`);
      const taskList = tasksRes.ok ? ((await tasksRes.json()) as TaskNode[]) : [];

      const latestByAgent = new Map<string, SessionLog>();
      for (const log of allLogs) {
        const existing = latestByAgent.get(log.agentId);
        if (!existing || new Date(log.startTime).getTime() > new Date(existing.startTime).getTime()) {
          latestByAgent.set(log.agentId, log);
        }
      }

      const agentsFromLogs: AgentRuntime[] = Array.from(latestByAgent.values()).map((log) => {
        const currentRound = log.iterations.length;
        const load = computeAgentLoadFromLog(log);

        return {
          id: log.agentId,
          name: log.agentId,
          type: inferAgentType(log.agentId),
          status: inferAgentStatus(log),
          load,
          errorRate: log.finalError ? 100 : 0,
          requestCount: currentRound,
          tokenUsage: 0,
          currentTaskId: log.taskId,
        };
      });

      const assigneeSet = new Set(taskList.map((task) => task.assignee).filter((v): v is string => Boolean(v)));
      const agentsWithAssignees = [...agentsFromLogs];
      for (const assignee of assigneeSet) {
        if (!agentsWithAssignees.some((agent) => agent.id === assignee)) {
          agentsWithAssignees.push({
            id: assignee,
            name: assignee,
            type: inferAgentType(assignee),
            status: 'idle',
            load: 0,
            errorRate: 0,
            requestCount: 0,
            tokenUsage: 0,
          });
        }
      }

      if (!agentsWithAssignees.some((agent) => agent.type === 'orchestrator')) {
        agentsWithAssignees.push({
          id: 'orchestrator-loop',
          name: 'orchestrator-loop',
          type: 'orchestrator',
          status: selectedWorkflow.status === 'failed' ? 'error' : selectedWorkflow.status === 'paused' ? 'paused' : 'running',
          load: 0,
          errorRate: 0,
          requestCount: 0,
          tokenUsage: 0,
        });
      }

      const orchestratorLog = Array.from(latestByAgent.values())
        .filter((log) => inferAgentType(log.agentId) === 'orchestrator')
        .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())[0];

      const executionPath = buildRoundExecutionPath(taskList, 'orchestrator-loop');

      setExecutionState((prev) => ({
        workflowId: selectedWorkflow.id,
        status: selectedWorkflow.status,
        orchestrator: {
          id: 'orchestrator-loop',
          currentRound: orchestratorLog?.iterations.length || prev?.orchestrator.currentRound || 0,
          maxRounds: Math.max(orchestratorLog?.totalRounds || 10, 1),
          thought: orchestratorLog?.iterations[orchestratorLog.iterations.length - 1]?.thought,
        },
        agents: agentsWithAssignees,
        tasks: taskList,
        executionPath,
        paused: selectedWorkflow.status === 'paused',
        userInput: prev?.userInput,
        executionRounds: prev?.executionRounds || [],
      }));

      // 根据任务状态构建执行轮次并更新状态
      const rounds = buildExecutionRoundsFromTasks(taskList, agentsWithAssignees);
      setExecutionRounds(rounds);
    } catch {
      // keep current UI state if polling fails
    }
  }, [sessionId, workflow?.id]);

  useEffect(() => {
    void refreshRuntimeState();
    const timer = setInterval(() => {
      void refreshRuntimeState();
    }, 3000);
    return () => clearInterval(timer);
  }, [refreshRuntimeState]);

  const startWorkflow = useCallback(
    async (userTask: string) => {
      setIsLoading(true);
      setError(null);

      try {
        const res = await fetch('/api/v1/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target: 'orchestrator-loop',
            message: { content: userTask, sessionId },
            blocking: false,
          }),
        });

        if (!res.ok) {
          throw new Error(`Failed to start workflow: ${res.status}`);
        }

        setExecutionState({
          workflowId: workflow?.id || `pending-${Date.now()}`,
          status: 'planning',
          orchestrator: {
            id: 'orchestrator-loop',
            currentRound: 0,
            maxRounds: 10,
          },
          agents: [
            {
              id: 'orchestrator-loop',
              name: 'orchestrator-loop',
              type: 'orchestrator',
              status: 'running',
              load: 1,
              errorRate: 0,
              requestCount: 0,
              tokenUsage: 0,
            },
          ],
          tasks: [],
          executionPath: [],
          paused: false,
          executionRounds: [],
        });

        await refreshRuntimeState();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to start workflow');
      } finally {
        setIsLoading(false);
      }
    },
    [refreshRuntimeState, sessionId, workflow?.id],
  );

  const pauseWorkflow = useCallback(async () => {
    if (!executionState) return;

    try {
      await fetch('/api/v1/workflow/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId: executionState.workflowId,
          hard: true,
        }),
      });

      setRuntimeEvents((prev) =>
        pushEvent(prev, {
          role: 'system',
          kind: 'status',
          content: '执行已暂停',
          timestamp: new Date().toISOString(),
        }),
      );

      setExecutionState((prev) => (prev ? { ...prev, paused: true, status: 'paused' } : prev));
    } catch {
      // ignore pause failure in UI
    }
  }, [executionState]);

  const resumeWorkflow = useCallback(async () => {
    if (!executionState) return;

    try {
      await fetch('/api/v1/workflow/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId: executionState.workflowId,
        }),
      });

      setRuntimeEvents((prev) =>
        pushEvent(prev, {
          role: 'system',
          kind: 'status',
          content: '执行已恢复',
          timestamp: new Date().toISOString(),
        }),
      );

      setExecutionState((prev) => (prev ? { ...prev, paused: false, status: 'executing' } : prev));
    } catch {
      // ignore resume failure in UI
    }
  }, [executionState]);

const sendUserInput = useCallback(
  async (inputPayload: UserInputPayload) => {
    const text = inputPayload.text.trim();
    if (!text && (!inputPayload.images || inputPayload.images.length === 0)) return;

    const eventTime = new Date().toISOString();
    const roundId = `user-round-${Date.now()}`;

    // 1. 先本地插入 pending 状态的用户事件（立即可见）
    setRuntimeEvents((prev) =>
      pushEvent(prev, {
       role: 'user',
       content: text || '[图片输入]',
       images: inputPayload.images,
       timestamp: eventTime,
       kind: 'status',
       agentId: 'pending',
     }),
   );

    // 2. 同步更新用户轮次
    setUserRounds((prev) => [
      ...prev,
      {
        roundId,
        timestamp: eventTime,
        summary: text ? (text.length > 24 ? `${text.slice(0, 24)}...` : text) : '[图片输入]',
        fullText: text,
        images: inputPayload.images,
      },
    ]);

    // 3. 检查是否需要启动新 workflow
    const hasRealWorkflow = executionState && !executionState.workflowId.startsWith('empty-') && !executionState.workflowId.startsWith('pending-');
    if (!hasRealWorkflow) {
      if (text && startWorkflow) {
        try {
          await startWorkflow(text);
        } catch (startErr) {
          // Keep UI responsive even if backend start call is unstable.
          console.error('[sendUserInput] startWorkflow error:', startErr);
        }
      }

      setRuntimeEvents((prev) => {
        const idx = prev.findIndex((e) => e.role === 'user' && e.timestamp === eventTime);
        if (idx < 0) return prev;
        const updated = [...prev];
        updated[idx] = { ...updated[idx], agentId: 'confirmed' };
        return updated;
      });
      return;
    }

    // 4. 发送 API 请求
    try {
      const res = await fetch('/api/v1/workflow/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId: executionState.workflowId,
          input: text || '[图片输入]',
        }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      // 5. API 成功：更新事件状态为 confirmed 并追加反馈
      let feedback: string | null = null;
      try {
        const responseData = await res.json() as { response?: string; event?: string; data?: unknown } | null;
        feedback =
          responseData?.response ||
          responseData?.event ||
          (typeof responseData?.data === 'string' ? responseData.data : null);
      } catch {
        // ignore json parse errors
      }

      setRuntimeEvents((prev) => {
        const confirmed = prev.map((e) =>
          e.role === 'user' && e.timestamp === eventTime
            ? { ...e, agentId: 'confirmed' }
            : e,
        );

        if (feedback) {
          return pushEvent(confirmed, {
            role: 'system',
            content: feedback,
            timestamp: new Date().toISOString(),
            kind: 'status',
          });
        }
        return confirmed;
      });

      setExecutionState((prev) => (prev ? { ...prev, userInput: text } : prev));
    } catch (err) {
      // 6. API 失败：更新事件为 error 并追加错误事件
      setRuntimeEvents((prev) =>
        prev.map((e) =>
          e.role === 'user' && e.timestamp === eventTime
            ? { ...e, agentId: 'error', kind: 'status' }
            : e
        ),
      );

      const errorMsg = err instanceof Error ? err.message : '发送失败';
      setRuntimeEvents((prev) =>
        pushEvent(prev, {
          role: 'system',
          content: `发送失败：${errorMsg}`,
          timestamp: new Date().toISOString(),
          kind: 'status',
          agentId: 'error',
        }),
      );
    }
  },
  [executionState, startWorkflow],
);

  const getAgentDetail = useCallback(
    (agentId: string): AgentExecutionDetail | null => {
      const latestLog = logs
        .filter((log) => log.agentId === agentId)
        .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())[0];

      const agent = executionState?.agents.find((a) => a.id === agentId);
      if (!agent && !latestLog) return null;

      return {
        agentId,
        agentName: agent?.name || agentId,
        taskId: latestLog?.taskId,
        taskDescription: latestLog?.userTask,
        status: agent?.status || (latestLog ? inferAgentStatus(latestLog) : 'idle'),
        steps: (latestLog?.iterations || []).map((iteration) => ({
          round: iteration.round,
          action: iteration.action,
          thought: iteration.thought,
          params: iteration.params,
          observation: iteration.observation,
          success: iteration.success,
          timestamp: iteration.timestamp,
          duration: iteration.duration,
        })),
        currentRound: latestLog?.iterations.length || 0,
        totalRounds: latestLog?.totalRounds || latestLog?.iterations.length || 0,
        startTime: latestLog?.startTime || new Date().toISOString(),
        endTime: latestLog?.endTime,
      };
    },
    [executionState, logs],
  );

  const getTaskReport = useCallback((): TaskReport | null => {
    if (!workflow || !executionState) return null;

    const completedTasks = executionState.tasks.filter((t) => t.status === 'completed');
    const failedTasks = executionState.tasks.filter((t) => t.status === 'failed');

    return {
      workflowId: executionState.workflowId,
      epicId: workflow.epicId,
      userTask: workflow.userTask,
      status: executionState.status,
      summary: {
        totalTasks: executionState.tasks.length,
        completed: completedTasks.length,
        failed: failedTasks.length,
        success: failedTasks.length === 0 && completedTasks.length === executionState.tasks.length,
        rounds: executionState.orchestrator.currentRound,
        duration: 0,
      },
      taskDetails: executionState.tasks.map((task) => ({
        taskId: task.id,
        description: task.description,
        status: task.status,
        assignee: task.assignee,
        output: task.result?.output,
        error: task.result?.error,
      })),
      createdAt: workflow.createdAt,
      completedAt:
        executionState.status === 'completed' || executionState.status === 'failed'
          ? new Date().toISOString()
          : undefined,
    };
  }, [workflow, executionState]);

 return {
   workflow,
   executionState,
   runtimeEvents,
   userRounds,
   executionRounds,
   selectedAgentId,
   setSelectedAgentId,
   isLoading,
   error,
   startWorkflow,
   pauseWorkflow,
   resumeWorkflow,
   sendUserInput,
   getAgentDetail,
   getTaskReport,
   isConnected,
 };
}

function buildExecutionRoundsFromTasks(
  tasks: TaskNode[],
  _agents: AgentRuntime[],
): ExecutionRound[] {
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
      agentId: task.assignee || 'executor-loop',
      status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'error' : task.status === 'in_progress' ? 'running' : 'idle',
      taskId: task.id,
      taskDescription: task.description,
    };
    if (!round.agents.some((a) => a.agentId === agentInfo.agentId)) {
      round.agents.push(agentInfo);
    }

    const edgeInfo: RoundEdgeInfo = {
      from: 'orchestrator-loop',
      to: task.assignee || 'executor-loop',
      status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'error' : task.status === 'in_progress' ? 'active' : 'pending',
      message: `${task.id}: ${task.description.slice(0, 32)}`,
    };
    if (!round.edges.some((e) => e.to === edgeInfo.to && e.from === edgeInfo.from)) {
      round.edges.push(edgeInfo);
    }
  }

  return Array.from(roundMap.values()).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}
