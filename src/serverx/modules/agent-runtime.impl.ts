import type { Express } from 'express';
import { recommendLoopTemplates } from '../../orchestration/loop/loop-template-registry.js';
import { isObjectRecord } from '../../server/common/object.js';
import type { AgentCapabilityLayer, AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';
import { dispatchTaskToAgent } from '../../server/modules/agent-runtime/dispatch.js';
import { controlAgentRuntime } from '../../server/modules/agent-runtime/control.js';
import { registerMailboxRuntimeTools } from '../../server/modules/agent-runtime/mailbox.js';
import { parseAskToolInput, runBlockingAsk } from '../../server/modules/agent-runtime/ask.js';
import { SYSTEM_PROJECT_PATH } from '../../agents/finger-system-agent/index.js';
import {
  parseAgentControlToolInput,
  parseAgentDeployToolInput,
  parseAgentDispatchToolInput,
} from '../../server/modules/agent-runtime/parsers.js';
import { parseProjectTaskState } from '../../common/project-task-state.js';
import { normalizeProjectPathCanonical } from '../../common/path-normalize.js';
import { applyProjectStatusGatewayPatch } from '../../server/modules/project-status-gateway.js';

function resolveAgentCapabilityLayer(value: unknown): AgentCapabilityLayer {
  if (typeof value !== 'string') return 'summary';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'execution') return 'execution';
  if (normalized === 'governance') return 'governance';
  if (normalized === 'full') return 'full';
  return 'summary';
}

function normalizeProjectPathInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return normalizeProjectPathCanonical(trimmed);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isReviewerAgentId(agentId: string): boolean {
  const normalized = agentId.trim().toLowerCase();
  return normalized.includes('reviewer') || normalized.includes('review');
}

function resolveRuntimeAgentSnapshot(
  runtimeView: unknown,
  agentId: string,
): {
  found: boolean;
  status?: string;
  busy: boolean;
  lastSummary?: string;
  lastTaskId?: string;
  lastDispatchId?: string;
  updatedAt?: string;
} {
  const view = isObjectRecord(runtimeView) ? runtimeView : {};
  const agents = Array.isArray(view.agents) ? view.agents : [];
  const target = agents.find((item) => isObjectRecord(item) && asTrimmedString(item.id) === agentId);
  const record = isObjectRecord(target) ? target : undefined;
  if (!record) return { found: false, busy: false };
  const status = asTrimmedString(record.status).toLowerCase();
  const lastEvent = isObjectRecord(record.lastEvent) ? record.lastEvent : {};
  const busy = status === 'running' || status === 'queued' || status === 'waiting_input' || status === 'paused';
  return {
    found: true,
    ...(status ? { status } : {}),
    busy,
    ...(asTrimmedString(lastEvent.summary) ? { lastSummary: asTrimmedString(lastEvent.summary) } : {}),
    ...(asTrimmedString(lastEvent.taskId) ? { lastTaskId: asTrimmedString(lastEvent.taskId) } : {}),
    ...(asTrimmedString(lastEvent.dispatchId) ? { lastDispatchId: asTrimmedString(lastEvent.dispatchId) } : {}),
    ...(asTrimmedString(lastEvent.timestamp) ? { updatedAt: asTrimmedString(lastEvent.timestamp) } : {}),
  };
}

function extractDispatchSummary(dispatchResult: unknown): string {
  if (!isObjectRecord(dispatchResult)) return '';
  const result = isObjectRecord(dispatchResult.result) ? dispatchResult.result : {};
  return (
    asTrimmedString(result.summary)
    || asTrimmedString(result.response)
    || asTrimmedString(result.message)
    || asTrimmedString(dispatchResult.error)
    || ''
  );
}

function resolveContinueSessionId(
  deps: AgentRuntimeDeps,
  input: Record<string, unknown>,
  context?: Record<string, unknown>,
): string {
  const fromInput = asTrimmedString(input.session_id ?? input.sessionId);
  if (fromInput) return fromInput;
  const fromContext = asTrimmedString(context?.sessionId);
  if (fromContext) return fromContext;
  const fromRuntime = asTrimmedString(deps.runtime.getCurrentSession()?.id);
  if (fromRuntime) return fromRuntime;
  return '';
}

export function registerAgentRuntimeTools(deps: AgentRuntimeDeps): string[] {
  const loaded: string[] = [];

  loaded.push(...registerMailboxRuntimeTools(deps));

  deps.runtime.registerTool({
    name: 'agent.list',
    description:
      'List available agents with layered capability exposure. layer: summary|execution|governance|full.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: { type: 'string', enum: ['summary', 'execution', 'governance', 'full'] },
      },
      additionalProperties: false,
    },
    handler: async (input: unknown): Promise<unknown> => {
      const layer = resolveAgentCapabilityLayer(isObjectRecord(input) ? input.layer : undefined);
      return deps.agentRuntimeBlock.execute('catalog', { layer });
    },
  });
  loaded.push('agent.list');

  deps.runtime.registerTool({
    name: 'agent.capabilities',
    description:
      'Get capability details for one target agent. Supports layered exposure with layer=summary|execution|governance|full.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        layer: { type: 'string', enum: ['summary', 'execution', 'governance', 'full'] },
      },
      required: ['agent_id'],
      additionalProperties: false,
    },
    handler: async (input: unknown): Promise<unknown> => {
      if (!isObjectRecord(input)) {
        throw new Error('agent.capabilities input must be object');
      }
      const agentId = typeof input.agent_id === 'string'
        ? input.agent_id.trim()
        : typeof input.agentId === 'string'
          ? input.agentId.trim()
          : '';
      if (agentId.length === 0) {
        throw new Error('agent.capabilities agent_id is required');
      }
      const layer = resolveAgentCapabilityLayer(input.layer);
      return deps.agentRuntimeBlock.execute('capabilities', { agentId, layer });
    },
  });
  loaded.push('agent.capabilities');

  deps.runtime.registerTool({
    name: 'agent.deploy',
    description:
      'Activate/start an agent target in resource pool. Use before dispatch when target is not started.',
    inputSchema: {
      type: 'object',
      properties: {
        target_agent_id: { type: 'string' },
        target_implementation_id: { type: 'string' },
        provider: { type: 'string' },
        instance_count: { type: 'number' },
        scope: { type: 'string', enum: ['session', 'global'] },
        launch_mode: { type: 'string', enum: ['manual', 'orchestrator'] },
        session_id: { type: 'string' },
        config: { type: 'object' },
      },
      additionalProperties: true,
    },
    handler: async (input: unknown): Promise<unknown> => {
      const deployInput = parseAgentDeployToolInput(input);
      return deps.agentRuntimeBlock.execute('deploy', deployInput);
    },
  });
  loaded.push('agent.deploy');

  deps.runtime.registerTool({
    name: 'agent.dispatch',
    description:
      'Dispatch a task to another agent/module through standard runtime routing. Required: target_agent_id + task. Optional session_strategy=current|latest|new (default latest/existing session) and project_path/cwd for automatic session + cwd targeting.',
    inputSchema: {
      type: 'object',
      properties: {
        source_agent_id: { type: 'string' },
        target_agent_id: { type: 'string' },
        task: {},
        session_id: { type: 'string' },
        session_strategy: { type: 'string', enum: ['current', 'latest', 'new'] },
        project_path: { type: 'string' },
        cwd: { type: 'string' },
        workflow_id: { type: 'string' },
        blocking: { type: 'boolean' },
        queue_on_busy: { type: 'boolean' },
        max_queue_wait_ms: { type: 'number' },
        assignment: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'Stable task identifier for dispatch/review linkage.' },
            task_name: { type: 'string', description: 'Human-readable task name for review contract matching.' },
            acceptance_criteria: { type: 'string', description: 'Delivery acceptance criteria used by reviewer.' },
            review_required: { type: 'boolean', description: 'Whether reviewer gate is required before completion.' },
            attempt: { type: 'number', description: 'Retry attempt number (starts at 1).' },
            phase: {
              type: 'string',
              enum: ['assigned', 'queued', 'started', 'reviewing', 'retry', 'passed', 'failed', 'closed'],
              description: 'Assignment lifecycle phase.',
            },
          },
        },
        metadata: { type: 'object' },
      },
      required: ['target_agent_id', 'task'],
      additionalProperties: true,
    },
    handler: async (input: unknown, context?: Record<string, unknown>): Promise<unknown> => {
      const callerAgentId = asTrimmedString(context?.agentId);
      if (callerAgentId && isReviewerAgentId(callerAgentId)) {
        throw new Error('agent.dispatch forbidden for reviewer role; reviewer must use report-task-completion');
      }
      const rawInput = isObjectRecord(input) ? input : {};
      const explicitSourceAgentId = asTrimmedString(rawInput.source_agent_id ?? rawInput.sourceAgentId);
      if (callerAgentId && explicitSourceAgentId && explicitSourceAgentId !== callerAgentId) {
        throw new Error(`agent.dispatch forbidden: source_agent_id must match caller agent (${callerAgentId})`);
      }

      const dispatchInput = parseAgentDispatchToolInput(input, deps);
      if (callerAgentId && !explicitSourceAgentId) {
        dispatchInput.sourceAgentId = callerAgentId;
      }
      return dispatchTaskToAgent(deps, dispatchInput);
    },
  });
  loaded.push('agent.dispatch');

  deps.runtime.registerTool({
    name: 'agent.continue',
    description:
      'Continue an in-flight task/session without creating a new task identity. Uses bound session + active task contract.',
    inputSchema: {
      type: 'object',
      properties: {
        target_agent_id: { type: 'string' },
        session_id: { type: 'string' },
        task_id: { type: 'string' },
        task_name: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['target_agent_id'],
      additionalProperties: true,
    },
    handler: async (input: unknown, context?: Record<string, unknown>): Promise<unknown> => {
      const rawInput = isObjectRecord(input) ? input : {};
      const callerAgentId = asTrimmedString(context?.agentId) || deps.primaryOrchestratorAgentId;
      if (isReviewerAgentId(callerAgentId)) {
        throw new Error('agent.continue forbidden for reviewer role');
      }

      const targetAgentId = asTrimmedString(rawInput.target_agent_id ?? rawInput.targetAgentId);
      if (!targetAgentId) throw new Error('agent.continue target_agent_id is required');
      if (targetAgentId === callerAgentId) {
        throw new Error(`agent.continue self-dispatch forbidden: source and target are both ${targetAgentId}`);
      }

      const requestedSessionId = resolveContinueSessionId(deps, rawInput, context);
      if (!requestedSessionId) throw new Error('agent.continue session_id is required');
      const session = deps.sessionManager.getSession(requestedSessionId);
      if (!session) throw new Error(`agent.continue session not found: ${requestedSessionId}`);

      const taskState = parseProjectTaskState(session.context?.projectTaskState);
      const activeTaskId = asTrimmedString(taskState?.taskId);
      const activeTaskName = asTrimmedString(taskState?.taskName);
      const activeBoundSessionId = asTrimmedString(taskState?.boundSessionId);

      const taskId = asTrimmedString(rawInput.task_id ?? rawInput.taskId) || activeTaskId;
      const taskName = asTrimmedString(rawInput.task_name ?? rawInput.taskName) || activeTaskName;
      if (!taskId && !taskName) {
        throw new Error('agent.continue requires active task identity (task_id/task_name)');
      }

      const prompt = asTrimmedString(rawInput.prompt) || [
        '[Continue In-Flight Task]',
        taskId ? `taskId: ${taskId}` : '',
        taskName ? `taskName: ${taskName}` : '',
        'Continue execution on the same task/session; do not create a new task identity.',
      ].filter(Boolean).join('\n');

      const boundSessionId = activeBoundSessionId || requestedSessionId;
      const dispatchInput = {
        sourceAgentId: callerAgentId,
        targetAgentId,
        sessionId: boundSessionId,
        task: {
          prompt,
          metadata: {
            continueLane: true,
            continuedTask: true,
            taskId,
            taskName,
          },
        },
        assignment: {
          ...(taskId ? { taskId } : {}),
          ...(taskName ? { taskName } : {}),
          phase: 'started' as const,
        },
        metadata: {
          source: 'agent-continue',
          role: 'system',
          continueLane: true,
          continuedTask: true,
          ...(taskId ? { taskId } : {}),
          ...(taskName ? { taskName } : {}),
          boundSessionId,
        },
        queueOnBusy: true,
        maxQueueWaitMs: 0,
        blocking: false,
      };

      const dispatchResult = await dispatchTaskToAgent(deps, dispatchInput);
      return {
        ...dispatchResult,
        continue: true,
        ...(taskId ? { taskId } : {}),
        ...(taskName ? { taskName } : {}),
        sessionId: boundSessionId,
      };
    },
  });
  loaded.push('agent.continue');

  deps.runtime.registerTool({
    name: 'agent.query',
    description:
      'Synchronous cross-agent query with reply closure. Dispatches a question to target agent (blocking) and returns target reply in this turn so caller can continue reasoning.',
    inputSchema: {
      type: 'object',
      properties: {
        target_agent_id: { type: 'string' },
        query: { type: 'string' },
        session_id: { type: 'string' },
        project_path: { type: 'string' },
        cwd: { type: 'string' },
        workflow_id: { type: 'string' },
        timeout_ms: { type: 'number' },
        queue_on_busy: { type: 'boolean' },
      },
      required: ['target_agent_id', 'query'],
      additionalProperties: true,
    },
    handler: async (input: unknown, context?: Record<string, unknown>): Promise<unknown> => {
      const rawInput = isObjectRecord(input) ? input : {};
      const callerAgentId = asTrimmedString(context?.agentId) || deps.primaryOrchestratorAgentId;
      if (isReviewerAgentId(callerAgentId)) {
        throw new Error('agent.query forbidden for reviewer role');
      }
      const targetAgentId = asTrimmedString(rawInput.target_agent_id ?? rawInput.targetAgentId);
      if (!targetAgentId) throw new Error('agent.query target_agent_id is required');
      if (targetAgentId === callerAgentId) {
        throw new Error(`agent.query self-dispatch forbidden: source and target are both ${targetAgentId}`);
      }
      const query = asTrimmedString(rawInput.query);
      if (!query) throw new Error('agent.query query is required');
      const timeoutMsRaw = Number(rawInput.timeout_ms ?? rawInput.timeoutMs);
      const timeoutMs = Number.isFinite(timeoutMsRaw)
        ? Math.max(1_000, Math.min(180_000, Math.floor(timeoutMsRaw)))
        : 45_000;
      const queueOnBusy = rawInput.queue_on_busy !== false && rawInput.queueOnBusy !== false;
      const requestedSessionId = asTrimmedString(rawInput.session_id ?? rawInput.sessionId)
        || asTrimmedString(context?.sessionId)
        || asTrimmedString(deps.runtime.getCurrentSession()?.id);
      const projectPath = asTrimmedString(rawInput.project_path ?? rawInput.projectPath ?? rawInput.cwd);
      const workflowId = asTrimmedString(rawInput.workflow_id ?? rawInput.workflowId);
      const requestId = `agent-query-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const prompt = [
        '[AGENT QUERY REQUEST]',
        `request_id: ${requestId}`,
        `from_agent: ${callerAgentId}`,
        `to_agent: ${targetAgentId}`,
        '',
        'Question:',
        query,
        '',
        'Response contract:',
        '- Give a direct answer with evidence.',
        '- Keep it concise and actionable.',
      ].join('\n');

      const dispatchResult = await dispatchTaskToAgent(deps, {
        sourceAgentId: callerAgentId,
        targetAgentId,
        ...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
        ...(workflowId ? { workflowId } : {}),
        ...(projectPath ? { projectPath } : {}),
        task: {
          prompt,
          metadata: {
            queryRequest: true,
            queryRequestId: requestId,
            sourceAgentId: callerAgentId,
          },
        },
        metadata: {
          source: 'agent-query',
          role: 'system',
          queryRequest: true,
          queryRequestId: requestId,
          sourceAgentId: callerAgentId,
        },
        blocking: true,
        queueOnBusy,
        maxQueueWaitMs: timeoutMs,
      });

      const answer = extractDispatchSummary(dispatchResult);
      return {
        ...dispatchResult,
        request_id: requestId,
        target_agent_id: targetAgentId,
        answered: dispatchResult.status === 'completed' && answer.length > 0,
        ...(answer ? { answer } : {}),
      };
    },
  });
  loaded.push('agent.query');

  deps.runtime.registerTool({
    name: 'agent.progress.ask',
    description:
      'Ask target agent progress with reply closure. Returns direct progress reply when available; otherwise falls back to runtime snapshot for deterministic monitoring.',
    inputSchema: {
      type: 'object',
      properties: {
        target_agent_id: { type: 'string' },
        session_id: { type: 'string' },
        task_id: { type: 'string' },
        task_name: { type: 'string' },
        question: { type: 'string' },
        timeout_ms: { type: 'number' },
        queue_on_busy: { type: 'boolean' },
      },
      required: ['target_agent_id'],
      additionalProperties: true,
    },
    handler: async (input: unknown, context?: Record<string, unknown>): Promise<unknown> => {
      const rawInput = isObjectRecord(input) ? input : {};
      const callerAgentId = asTrimmedString(context?.agentId) || deps.primaryOrchestratorAgentId;
      if (isReviewerAgentId(callerAgentId)) {
        throw new Error('agent.progress.ask forbidden for reviewer role');
      }
      const targetAgentId = asTrimmedString(rawInput.target_agent_id ?? rawInput.targetAgentId);
      if (!targetAgentId) throw new Error('agent.progress.ask target_agent_id is required');
      if (targetAgentId === callerAgentId) {
        throw new Error(`agent.progress.ask self-dispatch forbidden: source and target are both ${targetAgentId}`);
      }
      const requestedSessionId = asTrimmedString(rawInput.session_id ?? rawInput.sessionId)
        || asTrimmedString(context?.sessionId)
        || asTrimmedString(deps.runtime.getCurrentSession()?.id);
      const taskId = asTrimmedString(rawInput.task_id ?? rawInput.taskId);
      const taskName = asTrimmedString(rawInput.task_name ?? rawInput.taskName);
      const question = asTrimmedString(rawInput.question)
        || '请汇报当前进度、阻塞点、下一步动作，并给出关键证据。';
      const timeoutMsRaw = Number(rawInput.timeout_ms ?? rawInput.timeoutMs);
      const timeoutMs = Number.isFinite(timeoutMsRaw)
        ? Math.max(1_000, Math.min(180_000, Math.floor(timeoutMsRaw)))
        : 30_000;
      const queueOnBusy = rawInput.queue_on_busy !== false && rawInput.queueOnBusy !== false;
      const requestId = `agent-progress-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const prompt = [
        '[AGENT PROGRESS REQUEST]',
        `request_id: ${requestId}`,
        `from_agent: ${callerAgentId}`,
        `to_agent: ${targetAgentId}`,
        taskId ? `task_id: ${taskId}` : '',
        taskName ? `task_name: ${taskName}` : '',
        '',
        '请按以下结构回复：',
        '- status: queued|in_progress|blocked|review|completed',
        '- done: 已完成关键步骤（列表）',
        '- doing: 当前执行中',
        '- blockers: 阻塞项（若无写 none）',
        '- next: 下一步动作',
        '- evidence: 关键证据（工具调用/文件路径/日志）',
        '',
        `补充问题: ${question}`,
      ].filter(Boolean).join('\n');

      const dispatchResult = await dispatchTaskToAgent(deps, {
        sourceAgentId: callerAgentId,
        targetAgentId,
        ...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
        task: {
          prompt,
          metadata: {
            progressAsk: true,
            queryRequestId: requestId,
            ...(taskId ? { taskId } : {}),
            ...(taskName ? { taskName } : {}),
          },
        },
        metadata: {
          source: 'agent-progress-ask',
          role: 'system',
          progressAsk: true,
          queryRequestId: requestId,
          ...(taskId ? { taskId } : {}),
          ...(taskName ? { taskName } : {}),
        },
        blocking: true,
        queueOnBusy,
        maxQueueWaitMs: timeoutMs,
      });

      const answer = extractDispatchSummary(dispatchResult);
      const runtimeView = await deps.agentRuntimeBlock.execute('runtime_view', {});
      const snapshot = resolveRuntimeAgentSnapshot(runtimeView, targetAgentId);
      const canWriteGateway = typeof (deps.sessionManager as { updateContext?: unknown }).updateContext === 'function';
      if (canWriteGateway && requestedSessionId) {
        const effectiveTaskId = taskId || snapshot.lastTaskId || '';
        const gatewaySummary = answer || snapshot.lastSummary || '';
        if (effectiveTaskId || taskName || gatewaySummary) {
          void applyProjectStatusGatewayPatch({
            sessionManager: deps.sessionManager,
            sessionIds: [requestedSessionId],
            source: 'agent.progress.ask',
            patch: {
              ...(effectiveTaskId ? { taskId: effectiveTaskId } : {}),
              ...(taskName ? { taskName } : {}),
              ...(snapshot.lastDispatchId ? { dispatchId: snapshot.lastDispatchId } : {}),
              ...(gatewaySummary ? { summary: gatewaySummary.slice(0, 2000) } : {}),
              note: answer ? 'progress_ask_reply' : 'progress_snapshot_only',
              requestId,
            },
          });
        }
      }
      return {
        ...dispatchResult,
        request_id: requestId,
        target_agent_id: targetAgentId,
        answered: dispatchResult.status === 'completed' && answer.length > 0,
        ...(answer ? { progress: answer } : {}),
        status_snapshot: snapshot,
      };
    },
  });
  loaded.push('agent.progress.ask');

  deps.runtime.registerTool({
    name: 'agent.control',
    description:
      'Control or query runtime state. action: status|pause|resume|interrupt|cancel. Use session_id/workflow_id as scope.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'pause', 'resume', 'interrupt', 'cancel'] },
        target_agent_id: { type: 'string' },
        session_id: { type: 'string' },
        workflow_id: { type: 'string' },
        provider_id: { type: 'string' },
        hard: { type: 'boolean' },
      },
      required: ['action'],
      additionalProperties: true,
    },
    handler: async (input: unknown): Promise<unknown> => {
      const controlInput = parseAgentControlToolInput(input);
      return controlAgentRuntime(deps, controlInput);
    },
  });
  loaded.push('agent.control');

  deps.runtime.registerTool({
    name: 'orchestrator.loop_templates',
    description:
      'Suggest loop templates and blocking split for current task set. Templates: epic_planning|parallel_execution|review_retry|search_evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
              blockedBy: { type: 'array', items: { type: 'string' } },
            },
            required: ['description'],
            additionalProperties: true,
          },
        },
        context_consumption: { type: 'string', enum: ['low', 'medium', 'high'] },
        requires_evidence: { type: 'boolean' },
      },
      additionalProperties: true,
    },
    handler: async (input: unknown): Promise<unknown> => {
      if (!isObjectRecord(input)) {
        throw new Error('orchestrator.loop_templates input must be object');
      }
      const contextConsumption = typeof input.context_consumption === 'string'
        ? input.context_consumption
        : typeof input.contextConsumption === 'string'
          ? input.contextConsumption
          : undefined;
      const tasksRaw = Array.isArray(input.tasks)
        ? input.tasks
        : undefined;
      const taskItems = tasksRaw?.map((item) => {
        const record = isObjectRecord(item) ? item : {};
        return {
          ...(typeof record.id === 'string' ? { id: record.id } : {}),
          description: typeof record.description === 'string'
            ? record.description
            : typeof record.task === 'string'
              ? record.task
              : '',
          ...(Array.isArray(record.blockedBy) ? { blockedBy: record.blockedBy } : Array.isArray(record.blocked_by) ? { blockedBy: record.blocked_by } : {}),
        };
      }).filter((item) => typeof item.description === 'string' && item.description.trim().length > 0);

      return recommendLoopTemplates({
        ...(typeof input.task === 'string' && input.task.trim().length > 0 ? { task: input.task.trim() } : {}),
        ...(taskItems && taskItems.length > 0 ? { tasks: taskItems } : {}),
        ...(contextConsumption === 'low' || contextConsumption === 'medium' || contextConsumption === 'high'
          ? { contextConsumption }
          : {}),
        ...(input.requires_evidence === true || input.requiresEvidence === true ? { requiresEvidence: true } : {}),
      });
    },
  });
  loaded.push('orchestrator.loop_templates');

  deps.runtime.registerTool({
    name: 'user.ask',
    description:
      'Blocking user decision gate. Use ONLY when execution is truly blocked by a critical decision, missing credentials, or irreversible-risk confirmation. This tool blocks until user response or timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Question shown to user. Must be specific and actionable.' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional choices presented to user.' },
        context: { type: 'string', description: 'Optional context for the user.' },
        blocking_reason: { type: 'string', description: 'Why execution is blocked and must wait user decision.' },
        decision_impact: { type: 'string', enum: ['critical', 'major', 'normal'] },
        timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds.' },
        session_id: { type: 'string' },
        workflow_id: { type: 'string' },
        epic_id: { type: 'string' },
        agent_id: { type: 'string' },
        channel_id: { type: 'string' },
        user_id: { type: 'string' },
        group_id: { type: 'string' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    handler: async (input: unknown, context?: Record<string, unknown>): Promise<unknown> => {
      const request = parseAskToolInput(input);
      const fallbackAgentId = asTrimmedString(context?.agentId);
      const fallbackSessionId = asTrimmedString(context?.sessionId);
      return runBlockingAsk(deps, {
        ...request,
        ...(request.agentId ? {} : (fallbackAgentId ? { agentId: fallbackAgentId } : {})),
        ...(request.sessionId ? {} : (fallbackSessionId ? { sessionId: fallbackSessionId } : {})),
      });
    },
  });
  loaded.push('user.ask');

  // Progress update tool - lets agent inject progress text without breaking execution flow
  deps.runtime.registerTool({
    name: 'update_progress',
    description:
      'Inject a progress update to the user. Use this to announce your goal before starting a task, or report progress mid-execution. Returns immediately so your workflow is not interrupted.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Progress message to show the user (concise, actionable).',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    handler: async (input: unknown): Promise<unknown> => {
      const raw = isObjectRecord(input) ? input : {};
      const text = typeof raw.text === 'string' ? raw.text.trim() : '';
      if (!text) return { ok: true, message: 'empty' };

      deps.broadcast({
        type: 'reasoning',
        payload: { text: text.slice(0, 500) },
        timestamp: new Date().toISOString(),
      });

      return { ok: true, message: 'progress updated' };
    },
  });
  loaded.push('update_progress');


  // Session switching tool
  deps.runtime.registerTool({
    name: 'session.switch',
    description: 'Session switching is disabled by system policy.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
      },
      required: ['session_id'],
      additionalProperties: false
    },
    handler: async (input: unknown): Promise<unknown> => {
      void input;
      throw new Error('session.switch is disabled by system policy. Session binding is runtime-init only.');
    }
  });
  loaded.push('session.switch');

  // Session list tool
  deps.runtime.registerTool({
    name: 'session.list',
    description: 'List all sessions in the current project',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        project_path: { type: 'string' },
        cwd: { type: 'string' },
        include_runtime_child: { type: 'boolean' },
        include_system: { type: 'boolean' },
      },
      additionalProperties: false
    },
    handler: async (input: unknown): Promise<unknown> => {
      const raw = isObjectRecord(input) ? input : {};
      const limit = typeof raw.limit === 'number' ? raw.limit : undefined;
      const includeRuntimeChild = raw.include_runtime_child === true;
      const includeSystem = raw.include_system === true;
      const requestedProjectPath = typeof raw.project_path === 'string'
        ? raw.project_path
        : typeof raw.cwd === 'string'
          ? raw.cwd
          : deps.runtime.getCurrentSession()?.projectPath ?? process.cwd();
      const normalizedProjectPath = normalizeProjectPathInput(requestedProjectPath);
      const normalizedSystemPath = normalizeProjectPathInput(SYSTEM_PROJECT_PATH);
      const sessions = deps.runtime.listSessions()
        .filter((session) => normalizeProjectPathInput(session.projectPath) === normalizedProjectPath)
        .filter((session) => {
          if (includeRuntimeChild) return true;
          const full = deps.sessionManager.getSession(session.id);
          return !deps.isRuntimeChildSession(full);
        })
        .filter((session) => {
          if (includeSystem) return true;
          const normalized = normalizeProjectPathInput(session.projectPath);
          if (normalized === normalizedSystemPath) return false;
          const full = deps.sessionManager.getSession(session.id);
          const context = full?.context && typeof full.context === 'object'
            ? full.context as Record<string, unknown>
            : {};
          const ownerAgentId = typeof context.ownerAgentId === 'string' ? context.ownerAgentId : '';
          const sessionTier = typeof context.sessionTier === 'string' ? context.sessionTier : '';
          return ownerAgentId !== 'finger-system-agent' && sessionTier !== 'system' && !session.id.startsWith('system-');
        })
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      const result = limit && limit > 0 ? sessions.slice(0, limit) : sessions;

      return {
        sessions: result.map(s => ({
          session_id: s.id,
          name: s.name,
          project_path: s.projectPath,
          created_at: s.createdAt,
          last_accessed_at: s.updatedAt,
          message_count: s.messageCount
        })),
        total: sessions.length,
        project_path: normalizedProjectPath,
      };
    }
  });
  loaded.push('session.list');


  // CommandHub exec tool - shared command processing
  deps.runtime.registerTool({
    name: 'command.exec',
    description: 'Execute <##...##> commands via shared CommandHub (MessageHub/System Agent/CLI unified).',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Command string, e.g. <##@system:provider:list##>' },
      },
      required: ['input'],
      additionalProperties: false,
    },
    handler: async (input: unknown): Promise<unknown> => {
      if (!isObjectRecord(input) || typeof input.input !== 'string') {
        throw new Error('command.exec input must be { input: string }');
      }
      const { parseCommands, getCommandHub } = await import('../../blocks/command-hub/index.js');
      const parsed = parseCommands(input.input);
      if (parsed.commands.length === 0) {
        return { success: false, output: '未检测到命令' };
      }
      const executor = getCommandHub();
      const result = await executor.execute(parsed.commands[0], {
        channelId: 'agent',
        configPath: `${process.env.HOME || ''}/.finger/config/config.json`,
        updateContext: (id, mode, agentId) => {
          const { ChannelContextManager } = require('../../orchestration/channel-context-manager.js');
          const ctxMgr = ChannelContextManager.getInstance();
          ctxMgr.updateContext(id, mode, agentId);
        }
      });
      return result;
    }
  });
  loaded.push('command.exec');
  return loaded;
}

export function registerAgentRuntimeRoutes(app: Express, deps: AgentRuntimeDeps): void {
  app.get('/api/v1/agents/runtime-view', (_req, res) => {
    void deps.agentRuntimeBlock.execute('runtime_view', {}).then((snapshot) => {
      res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        ...(snapshot as Record<string, unknown>),
      });
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    });
  });
}
