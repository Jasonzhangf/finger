import type { SessionManager } from '../../orchestration/session-manager.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import type { AgentStepCompletedEvent, ToolCallEvent, ToolErrorEvent, ToolResultEvent } from '../../runtime/events.js';
import type { ChatCodexLoopEvent } from '../../agents/finger-general/finger-general-module.js';
import { isObjectRecord } from '../common/object.js';

export interface EventForwardingDeps {
  eventBus: UnifiedEventBus;
  broadcast: (message: Record<string, unknown>) => void;
  sessionManager: SessionManager;
  runtimeInstructionBus: { push: (workflowId: string, content: string) => void };
  inferAgentRoleLabel: (agentId: string) => string;
  formatDispatchResultContent: (result: unknown, error?: string) => string;
  asString: (value: unknown) => string | undefined;
  generalAgentId: string;
}

type SessionEventRecord = {
  type: 'tool_call' | 'tool_result' | 'tool_error' | 'agent_step';
  agentId?: string;
  toolName?: string;
  toolStatus?: 'success' | 'error';
  toolDurationMs?: number;
  toolInput?: unknown;
  toolOutput?: unknown;
  metadata?: Record<string, unknown>;
};

interface LoopToolTraceItem {
  callId?: string;
  tool: string;
  status: 'ok' | 'error';
  input?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

function extractLoopToolTrace(raw: unknown): LoopToolTraceItem[] {
  if (!Array.isArray(raw)) return [];
  const items: LoopToolTraceItem[] = [];
  for (const entry of raw) {
    if (!isObjectRecord(entry)) continue;
    const tool = typeof entry.tool === 'string' ? entry.tool.trim() : '';
    if (!tool) continue;
    const status: LoopToolTraceItem['status'] = entry.status === 'error' ? 'error' : 'ok';
    const callId = typeof entry.callId === 'string' && entry.callId.trim().length > 0
      ? entry.callId.trim()
      : typeof entry.call_id === 'string' && entry.call_id.trim().length > 0
        ? entry.call_id.trim()
        : undefined;
    const error = typeof entry.error === 'string' && entry.error.trim().length > 0 ? entry.error.trim() : undefined;
    const durationMs = typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs)
      ? Math.round(entry.durationMs)
      : typeof entry.duration_ms === 'number' && Number.isFinite(entry.duration_ms)
        ? Math.round(entry.duration_ms)
        : undefined;
    items.push({
      ...(callId ? { callId } : {}),
      tool,
      status,
      ...(entry.input !== undefined ? { input: entry.input } : {}),
      ...(entry.output !== undefined ? { output: entry.output } : {}),
      ...(error ? { error } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  }
  return items;
}

function buildAgentStepContent(payload: AgentStepCompletedEvent['payload']): string {
  const parts: string[] = [];
  if (typeof payload.thought === 'string' && payload.thought.trim().length > 0) {
    parts.push(`思考: ${payload.thought.trim()}`);
  }
  if (typeof payload.action === 'string' && payload.action.trim().length > 0) {
    parts.push(`动作: ${payload.action.trim()}`);
  }
  if (typeof payload.observation === 'string' && payload.observation.trim().length > 0) {
    parts.push(`观察: ${payload.observation.trim()}`);
  }
  if (parts.length === 0) {
    return 'agent step 完成';
  }
  return parts.join('\n');
}

export function attachEventForwarding(deps: EventForwardingDeps): {
  emitLoopEventToEventBus: (event: ChatCodexLoopEvent) => void;
} {
  const {
    eventBus,
    broadcast,
    sessionManager,
    runtimeInstructionBus,
    inferAgentRoleLabel,
    formatDispatchResultContent,
    asString,
    generalAgentId,
  } = deps;

  const persistSessionEventMessage = (sessionId: string, content: string, detail: SessionEventRecord): void => {
    if (!sessionId || sessionId.trim().length === 0) return;
    sessionManager.addMessage(sessionId, 'system', content, detail);
  };

  const emitToolStepEventsFromLoopEvent = (event: ChatCodexLoopEvent): void => {
    if (event.phase !== 'kernel_event') return;
    if (event.payload.enableLegacyToolTraceFallback !== true) return;
    const eventType = typeof event.payload.type === 'string' ? event.payload.type : '';
    if (eventType !== 'task_complete') return;
    if (event.payload.syntheticToolEvents === true || event.payload.realtimeToolEvents === true) return;

    const toolTrace = extractLoopToolTrace(event.payload.toolTrace);
    if (toolTrace.length === 0) return;

    const base = Date.parse(event.timestamp);
    const baseMs = Number.isFinite(base) ? base : Date.now();
    for (let i = 0; i < toolTrace.length; i += 1) {
      const trace = toolTrace[i];
      const toolId = trace.callId ?? `${event.sessionId}-tool-${i + 1}`;
      const resultTimestamp = new Date(baseMs + i * 2 + 1).toISOString();

      if (trace.status === 'ok') {
        broadcast({
          type: 'tool_result',
          sessionId: event.sessionId,
          agentId: generalAgentId,
          timestamp: resultTimestamp,
          payload: {
            toolId,
            toolName: trace.tool,
            ...(trace.input !== undefined ? { input: trace.input } : {}),
            ...(trace.output !== undefined ? { output: trace.output } : {}),
            ...(typeof trace.durationMs === 'number' ? { duration: trace.durationMs } : {}),
          },
        });
        continue;
      }

      broadcast({
        type: 'tool_error',
        sessionId: event.sessionId,
        agentId: generalAgentId,
        timestamp: resultTimestamp,
        payload: {
          toolId,
          toolName: trace.tool,
          ...(trace.input !== undefined ? { input: trace.input } : {}),
          error: trace.error ?? `工具执行失败：${trace.tool}`,
          ...(typeof trace.durationMs === 'number' ? { duration: trace.durationMs } : {}),
        },
      });
    }
  };

  const emitLoopEventToEventBus = (event: ChatCodexLoopEvent): void => {
    if (!event.sessionId || event.sessionId === 'unknown') return;
    emitToolStepEventsFromLoopEvent(event);

    broadcast({
      type: 'chat_codex_turn',
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      payload: {
        phase: event.phase,
        ...event.payload,
      },
    });

    if (event.phase === 'turn_error') {
      void eventBus.emit({
        type: 'system_error',
        sessionId: event.sessionId,
        timestamp: event.timestamp,
        payload: {
          error: typeof event.payload.error === 'string' ? event.payload.error : 'finger-general runner error',
          component: 'finger-general-runner',
          recoverable: true,
        },
      });
    }
  };

  eventBus.subscribeMultiple(
    ['task_started', 'task_completed', 'task_failed', 'workflow_progress', 'phase_transition'],
    (event) => {
      const wsMsg = {
        type: 'workflow_update',
        sessionId: event.sessionId,
        payload: {
          workflowId: event.sessionId,
          taskId: (event.payload as any)?.taskId,
          status: event.type === 'task_completed' ? 'completed' : event.type === 'task_failed' ? 'failed' : 'executing',
          orchestratorState: event.type === 'phase_transition' ? { round: (event.payload as any)?.round } : undefined,
          taskUpdates: event.type === 'task_started' || event.type === 'task_completed' || event.type === 'task_failed' ? [{
            id: (event.payload as any)?.taskId,
            status: event.type === 'task_started' ? 'in_progress' : event.type === 'task_completed' ? 'completed' : 'failed',
          }] : undefined,
        },
        timestamp: event.timestamp,
      };
      broadcast(wsMsg);
    },
  );

  console.log('[Server] EventBus subscription enabled: task_started, task_completed, task_failed, workflow_progress, phase_transition');

  eventBus.subscribeMultiple(
    ['task_started', 'task_completed', 'task_failed', 'workflow_progress', 'phase_transition'],
    (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      const taskDetails = payload?.task || payload?.result;
      const wsMsg = {
        type: 'agent_update',
        sessionId: event.sessionId,
        payload: {
          agentId: (payload?.agentId as string | undefined) || event.sessionId,
          status: event.type === 'task_completed' ? 'idle' : event.type === 'task_failed' ? 'error' : 'running',
          currentTaskId: payload?.taskId as string | undefined,
          load: ((payload?.progress as number | undefined) ?? 0),
          step: {
            round: (payload?.round as number | undefined) ?? 1,
            thought: (taskDetails as any)?.thought,
            action: (taskDetails as any)?.action,
            observation: (taskDetails as any)?.observation || (taskDetails as any)?.result,
            success: event.type !== 'task_failed',
            timestamp: event.timestamp,
          },
        },
        timestamp: event.timestamp,
      };
      broadcast(wsMsg);
    },
  );

  eventBus.subscribeMultiple(
    ['task_started', 'task_completed', 'task_failed', 'workflow_progress', 'phase_transition'],
    (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      const step = (payload?.step as Record<string, unknown> | undefined) ?? {};

      const wsMsg = {
        type: 'agent_update',
        sessionId: event.sessionId,
        payload: {
          agentId: (payload?.agentId as string | undefined) || event.sessionId,
          status: (payload?.status as string | undefined) || 'running',
          currentTaskId: payload?.taskId as string | undefined,
          load: ((payload?.load as number | undefined) ?? (payload?.progress as number | undefined) ?? 0),
          step: {
            round: ((payload?.round as number | undefined) ?? (step.round as number | undefined) ?? 1),
            action: (payload?.action as string | undefined) || (step.action as string | undefined),
            thought: (payload?.thought as string | undefined) || (step.thought as string | undefined),
            observation: (payload?.observation as string | undefined) || (step.observation as string | undefined),
            params: (payload?.params as Record<string, unknown> | undefined) || (step.params as Record<string, unknown> | undefined),
            success: (payload?.success as boolean | undefined) !== false,
            timestamp: event.timestamp,
          },
        },
        timestamp: event.timestamp,
      };

      broadcast(wsMsg);
    },
  );

  console.log('[Server] EventBus agent forwarding enabled: agent_thought, agent_action, agent_observation, agent_step_completed');

  eventBus.subscribe('tool_call', (event) => {
    if (event.type !== 'tool_call') return;
    const toolEvent = event as ToolCallEvent;
    const content = `调用工具: ${toolEvent.toolName}`;
    persistSessionEventMessage(toolEvent.sessionId, content, {
      type: 'tool_call',
      agentId: toolEvent.agentId,
      toolName: toolEvent.toolName,
      toolInput: toolEvent.payload?.input,
      metadata: { event: toolEvent },
    });
  });

  eventBus.subscribe('tool_result', (event) => {
    if (event.type !== 'tool_result') return;
    const toolEvent = event as ToolResultEvent;
    const content = `工具完成: ${toolEvent.toolName}`;
    persistSessionEventMessage(toolEvent.sessionId, content, {
      type: 'tool_result',
      agentId: toolEvent.agentId,
      toolName: toolEvent.toolName,
      toolStatus: 'success',
      toolDurationMs: toolEvent.payload?.duration,
      toolInput: toolEvent.payload?.input,
      toolOutput: toolEvent.payload?.output,
      metadata: { event: toolEvent },
    });
  });

  eventBus.subscribe('tool_error', (event) => {
    if (event.type !== 'tool_error') return;
    const toolEvent = event as ToolErrorEvent;
    const content = `工具失败: ${toolEvent.toolName}`;
    persistSessionEventMessage(toolEvent.sessionId, content, {
      type: 'tool_error',
      agentId: toolEvent.agentId,
      toolName: toolEvent.toolName,
      toolStatus: 'error',
      toolDurationMs: toolEvent.payload?.duration,
      toolInput: toolEvent.payload?.input,
      toolOutput: toolEvent.payload?.error,
      metadata: { event: toolEvent },
    });
  });

  eventBus.subscribe('agent_step_completed', (event) => {
    if (event.type !== 'agent_step_completed') return;
    const stepEvent = event as AgentStepCompletedEvent;
    const content = buildAgentStepContent(stepEvent.payload);
    persistSessionEventMessage(stepEvent.sessionId, content, {
      type: 'agent_step',
      agentId: stepEvent.agentId,
      metadata: { event: stepEvent },
    });
  });

  eventBus.subscribe(
    'agent_step_completed',
    (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;

      const wsMsg = {
        type: 'agent_update',
        sessionId: event.sessionId,
        payload: {
          agentId: ('agentId' in event ? (event as { agentId?: string }).agentId : undefined) || event.sessionId,
          status: (payload?.success as boolean) !== false ? 'running' : 'error',
          currentTaskId: payload?.taskId as string | undefined,
          load: 50,
          step: {
            round: (payload?.round as number | undefined) ?? 1,
            thought: payload?.thought as string | undefined,
            action: payload?.action as string | undefined,
            observation: payload?.observation as string | undefined,
            success: (payload?.success as boolean | undefined) !== false,
            timestamp: event.timestamp,
          },
        },
        timestamp: event.timestamp,
      };

      broadcast(wsMsg);
    },
  );

  console.log('[Server] EventBus agent_step_completed forwarding enabled for detailed agent updates');

  eventBus.subscribe(
    'agent_runtime_dispatch',
    (event) => {
      const payload = event.payload as Record<string, unknown>;
      const status = typeof payload.status === 'string' ? payload.status : '';
      const sessionId = asString(event.sessionId) || asString(payload.sessionId);
      const targetAgentId = asString(payload.targetAgentId) ?? 'unknown-agent';
      const agentRole = inferAgentRoleLabel(targetAgentId);
      const assignment = isObjectRecord(payload.assignment) ? payload.assignment : null;
      const queuePosition = typeof payload.queuePosition === 'number' ? payload.queuePosition : undefined;
      const taskId = assignment && typeof assignment.taskId === 'string' ? assignment.taskId.trim() : '';
      const bdTaskId = assignment && typeof assignment.bdTaskId === 'string' ? assignment.bdTaskId.trim() : '';
      const statusLabel = status === 'queued' ? '排队' : status === 'completed' ? '完成' : status === 'failed' ? '失败' : status;
      const dispatchParts = [
        `派发给 ${agentRole}${targetAgentId ? ` (${targetAgentId})` : ''}`,
        statusLabel ? `状态 ${statusLabel}` : '',
        typeof queuePosition === 'number' ? `队列 #${queuePosition}` : '',
        taskId ? `task ${taskId}` : '',
        bdTaskId && !taskId ? `bd ${bdTaskId}` : '',
      ].filter((part) => part.length > 0);
      const dispatchContent = dispatchParts.join(' · ');
      if (sessionId && dispatchContent.length > 0) {
        sessionManager.addMessage(sessionId, 'system', dispatchContent, {
          type: 'dispatch',
          agentId: targetAgentId,
          metadata: { event, agentRole },
        });
        if (status === 'completed' || status === 'failed') {
          const resultContent = formatDispatchResultContent(payload.result, asString(payload.error));
          if (resultContent.trim().length > 0) {
            sessionManager.addMessage(sessionId, 'assistant', resultContent, {
              type: 'dispatch',
              agentId: targetAgentId,
              metadata: { event, agentRole },
            });
          }
        }
      }
      if (status !== 'completed' && status !== 'failed') return;
      if (!assignment) return;

      const feedback = {
        role: 'user',
        from: typeof payload.targetAgentId === 'string' ? payload.targetAgentId : 'unknown-assignee',
        status: status === 'completed' ? 'complete' : 'error',
        dispatchId: typeof payload.dispatchId === 'string' ? payload.dispatchId : '',
        task: typeof assignment.taskId === 'string' ? assignment.taskId : undefined,
        sourceAgentId: typeof payload.sourceAgentId === 'string' ? payload.sourceAgentId : undefined,
        assignment,
        ...(payload.result !== undefined ? { result: payload.result } : {}),
        ...(typeof payload.error === 'string' && payload.error.trim().length > 0 ? { error: payload.error } : {}),
      };
      const feedbackText = JSON.stringify(feedback);
      const workflowId = typeof payload.workflowId === 'string' && payload.workflowId.trim().length > 0
        ? payload.workflowId.trim()
        : undefined;
      const epicId = typeof assignment.epicId === 'string' && assignment.epicId.trim().length > 0
        ? assignment.epicId.trim()
        : undefined;
      if (workflowId) {
        runtimeInstructionBus.push(workflowId, feedbackText);
      }
      if (epicId && epicId !== workflowId) {
        runtimeInstructionBus.push(epicId, feedbackText);
      }

      broadcast({
        type: 'orchestrator_feedback',
        payload: feedback,
        timestamp: event.timestamp,
      });
    },
  );

  console.log('[Server] EventBus orchestrator feedback forwarding enabled: agent_runtime_dispatch');

  return { emitLoopEventToEventBus };
}
