import { logger } from '../../core/logger.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import type { RuntimeEvent } from '../../runtime/events.js';
import type { AgentRuntimeDeps } from './agent-runtime/types.js';
import type {
  ExecutionUpdateEvent,
  ExecutionUpdateSourceType,
} from './execution-update-types.js';
import { ExecutionUpdateCorrelationStore } from './execution-update-correlation-store.js';
import { ExecutionUpdateEventStore } from './execution-update-event-store.js';
import { inferUpdateStreamRole } from './update-stream-policy.js';
const log = logger.module('ExecutionUpdateShadowPipeline');

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function randomId(len = 8): string {
  return Math.random().toString(36).slice(2, 2 + len);
}

function normalizeSourceType(input: {
  sourceAgentId?: string;
  sourceTag?: string;
  toolName?: string;
}): ExecutionUpdateSourceType {
  const sourceAgentId = (input.sourceAgentId || '').toLowerCase();
  const sourceTag = (input.sourceTag || '').toLowerCase();
  const toolName = (input.toolName || '').toLowerCase();
  if (sourceAgentId.includes('heartbeat') || sourceTag.includes('heartbeat')) return 'heartbeat';
  if (sourceAgentId.includes('cron') || sourceTag.includes('cron')) return 'cron';
  if (sourceAgentId.includes('mailbox') || sourceTag.includes('mailbox') || toolName.startsWith('mailbox.')) return 'mailbox';
  if (sourceAgentId.includes('system')) return 'system-inject';
  return 'user';
}

function sanitizePayload(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  return raw as Record<string, unknown>;
}

export class ExecutionUpdateShadowPipeline {
  private unsubscribeMain: (() => void) | null = null;
  private unsubscribeReasoning: (() => void) | null = null;
  private processingChain: Promise<void> = Promise.resolve();
  private readonly correlation = new ExecutionUpdateCorrelationStore();
  private readonly eventStore = new ExecutionUpdateEventStore();
  private readonly enabled: boolean;

  constructor(
    private readonly eventBus: UnifiedEventBus,
    private readonly deps: AgentRuntimeDeps,
  ) {
    const raw = process.env.FINGER_EXECUTION_UPDATE_SHADOW;
    this.enabled = raw === undefined ? true : raw.trim().toLowerCase() !== 'false';
  }

  start(): void {
    if (!this.enabled) {
      log.info('Execution update shadow pipeline disabled by env');
      return;
    }
    if (this.unsubscribeMain) return;

    this.unsubscribeMain = this.eventBus.subscribeMultiple(
      [
        'agent_runtime_dispatch',
        'agent_runtime_control',
        'agent_runtime_status',
        'tool_call',
        'tool_result',
        'tool_error',
        'task_started',
        'task_progress',
        'task_completed',
        'task_failed',
        'task_blocked',
        'plan_updated',
        'workflow_progress',
        'assistant_complete',
        'turn_complete',
      ],
      (event: RuntimeEvent) => {
        this.enqueue(() => this.handleEvent(event as unknown as Record<string, unknown>));
      },
    );
    this.unsubscribeReasoning = this.eventBus.subscribe('kernel_reasoning', (event: RuntimeEvent) => {
      this.enqueue(() => this.handleKernelReasoning(event as unknown as Record<string, unknown>));
    });
    log.info('Execution update shadow pipeline started');
  }

  stop(): void {
    this.unsubscribeMain?.();
    this.unsubscribeMain = null;
    this.unsubscribeReasoning?.();
    this.unsubscribeReasoning = null;
    void this.processingChain
      .catch(() => undefined)
      .then(async () => this.eventStore.stop());
    log.info('Execution update shadow pipeline stopped');
  }

  private enqueue(work: () => Promise<void>): void {
    this.processingChain = this.processingChain
      .then(work)
      .catch((error) => {
        log.warn('Execution update shadow queued work failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
  private async handleEvent(event: Record<string, unknown>): Promise<void> {
    const type = asString(event.type);
    if (!type) return;
    try {
      switch (type) {
        case 'agent_runtime_dispatch':
          await this.handleDispatch(event);
          break;
        case 'agent_runtime_control':
          await this.handleRuntimeControl(event);
          break;
        case 'tool_call':
        case 'tool_result':
        case 'tool_error':
          await this.handleToolEvent(event, type);
          break;
        case 'task_started':
        case 'task_progress':
        case 'task_completed':
        case 'task_failed':
        case 'task_blocked':
          await this.handleTaskEvent(event, type);
          break;
        case 'plan_updated':
        case 'workflow_progress':
          await this.handleProgressEvent(event, type);
          break;
        case 'assistant_complete':
          await this.handleAssistantComplete(event);
          break;
        case 'agent_runtime_status':
          await this.handleRuntimeStatus(event);
          break;
        case 'turn_complete':
          await this.handleTurnComplete(event);
          break;
        default:
          break;
      }
    } catch (error) {
      log.warn('Failed to adapt runtime event to execution update', {
        eventType: type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleDispatch(event: Record<string, unknown>): Promise<void> {
    const payload = sanitizePayload(event.payload);
    const sessionId = asString(event.sessionId) || asString(payload.sessionId) || 'default';
    const dispatchId = asString(payload.dispatchId) || `dispatch-${Date.now().toString(36)}-${randomId(6)}`;
    const assignment = sanitizePayload(payload.assignment);
    const taskId = asString(assignment.taskId);
    const flowId = taskId || dispatchId;
    const sourceAgentId = asString(payload.sourceAgentId) || asString(event.agentId) || 'unknown-agent';
    const targetAgentId = asString(payload.targetAgentId) || undefined;

    const correlation = await this.correlation.upsertFlow({ flowId, taskId });
    const next = await this.correlation.nextSeq(flowId);
    if (targetAgentId) {
      await this.correlation.bindSessionAgentFlow(sessionId, targetAgentId, flowId);
    }
    await this.correlation.bindSessionAgentFlow(sessionId, sourceAgentId, flowId);

    const output: ExecutionUpdateEvent = {
      id: `exeupd-${Date.now().toString(36)}-${randomId(8)}`,
      ts: asString(event.timestamp) || new Date().toISOString(),
      seq: next.seq,
      flowId,
      traceId: next.traceId || correlation.traceId,
      ...(taskId ? { taskId } : {}),
      sessionId,
      sourceAgentId,
      ...(targetAgentId ? { targetAgentId } : {}),
      sourceType: normalizeSourceType({
        sourceAgentId,
        sourceTag: asString(payload.source),
      }),
      phase: 'dispatch',
      kind: 'status',
      level: asString(payload.status).toLowerCase() === 'failed' ? 'critical' : 'milestone',
      payload: {
        status: asString(payload.status) || 'queued',
        blocking: payload.blocking === true,
        ...(asString(payload.dispatchId) ? { dispatchId } : {}),
        ...(asString(payload.error) ? { error: asString(payload.error) } : {}),
        ...(typeof payload.queuePosition === 'number' ? { queuePosition: payload.queuePosition } : {}),
      },
    };
    await this.eventStore.append(output);
  }

  private async handleToolEvent(event: Record<string, unknown>, type: string): Promise<void> {
    const payload = sanitizePayload(event.payload);
    const sessionId = asString(event.sessionId) || 'default';
    const agentId = asString(event.agentId) || asString(payload.agentId) || 'unknown-agent';
    const toolName = asString(event.toolName) || asString(payload.toolName) || 'unknown-tool';
    const sourceTag = asString(payload.source);
    const existingFlow = await this.correlation.resolveFlowBySessionAgent(sessionId, agentId);
    const flowId = existingFlow || `flow-${sessionId}-${agentId}`;
    if (!existingFlow) {
      await this.correlation.upsertFlow({ flowId });
      await this.correlation.bindSessionAgentFlow(sessionId, agentId, flowId);
    }
    const next = await this.correlation.nextSeq(flowId);
    const output: ExecutionUpdateEvent = {
      id: `exeupd-${Date.now().toString(36)}-${randomId(8)}`,
      ts: asString(event.timestamp) || new Date().toISOString(),
      seq: next.seq,
      flowId,
      traceId: next.traceId,
      ...(next.taskId ? { taskId: next.taskId } : {}),
      sessionId,
      sourceAgentId: agentId,
      sourceType: normalizeSourceType({
        sourceAgentId: agentId,
        sourceTag,
        toolName,
      }),
      phase: 'execution',
      kind: type === 'tool_error' ? 'error' : 'tool',
      level: type === 'tool_error' ? 'critical' : 'info',
      payload: {
        eventType: type,
        toolName,
        toolId: asString(event.toolId) || asString(payload.toolId) || undefined,
        ...(type === 'tool_error' ? { error: asString(payload.error) || 'tool failed' } : {}),
      },
    };
    await this.eventStore.append(output);
  }

  private async handleRuntimeStatus(event: Record<string, unknown>): Promise<void> {
    const payload = sanitizePayload(event.payload);
    const sessionId = asString(event.sessionId) || asString(payload.sessionId) || 'default';
    const runningAgents = Array.isArray(payload.runningAgents)
      ? payload.runningAgents.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const agentId = asString(event.agentId) || runningAgents[0] || 'unknown-agent';
    const existingFlow = await this.correlation.resolveFlowBySessionAgent(sessionId, agentId);
    const flowId = existingFlow || `flow-${sessionId}-${agentId}`;
    if (!existingFlow) {
      await this.correlation.upsertFlow({ flowId });
      await this.correlation.bindSessionAgentFlow(sessionId, agentId, flowId);
    }
    const next = await this.correlation.nextSeq(flowId);
    const status = asString(payload.status) || 'unknown';
    const output: ExecutionUpdateEvent = {
      id: `exeupd-${Date.now().toString(36)}-${randomId(8)}`,
      ts: asString(event.timestamp) || new Date().toISOString(),
      seq: next.seq,
      flowId,
      traceId: next.traceId,
      ...(next.taskId ? { taskId: next.taskId } : {}),
      sessionId,
      sourceAgentId: agentId,
      sourceType: normalizeSourceType({ sourceAgentId: agentId }),
      phase: status === 'ok' ? 'execution' : 'completion',
      kind: status === 'error' ? 'error' : 'status',
      level: status === 'error' ? 'critical' : 'info',
      payload: {
        scope: asString(payload.scope) || 'session',
        status,
        runningAgents,
        ...(asString(payload.error) ? { error: asString(payload.error) } : {}),
      },
    };
    await this.eventStore.append(output);
  }

  private async handleRuntimeControl(event: Record<string, unknown>): Promise<void> {
    const payload = sanitizePayload(event.payload);
    const sessionId = asString(event.sessionId) || asString(payload.sessionId) || 'default';
    const action = asString(payload.action) || 'status';
    const status = asString(payload.status) || 'accepted';
    const agentId = asString(event.agentId) || this.resolveLifecycleAgent(sessionId);
    const flowId = await this.correlation.resolveFlowBySessionAgent(sessionId, agentId) || `flow-${sessionId}-${agentId}`;
    await this.correlation.upsertFlow({ flowId });
    await this.correlation.bindSessionAgentFlow(sessionId, agentId, flowId);
    const next = await this.correlation.nextSeq(flowId);
    const output: ExecutionUpdateEvent = {
      id: `exeupd-${Date.now().toString(36)}-${randomId(8)}`,
      ts: asString(event.timestamp) || new Date().toISOString(),
      seq: next.seq,
      flowId,
      traceId: next.traceId,
      ...(next.taskId ? { taskId: next.taskId } : {}),
      sessionId,
      sourceAgentId: agentId,
      sourceType: normalizeSourceType({ sourceAgentId: agentId }),
      phase: action === 'interrupt' || action === 'cancel' ? 'completion' : 'dispatch',
      kind: status === 'failed' ? 'error' : 'decision',
      level: status === 'failed' ? 'critical' : 'milestone',
      payload: {
        action,
        status,
        ...(asString(payload.error) ? { error: asString(payload.error) } : {}),
      },
    };
    await this.eventStore.append(output);
  }

  private async handleTaskEvent(event: Record<string, unknown>, type: string): Promise<void> {
    const payload = sanitizePayload(event.payload);
    const sessionId = asString(event.sessionId) || 'default';
    const agentId = asString(event.agentId) || this.resolveLifecycleAgent(sessionId);
    const taskId = asString(event.taskId) || asString(payload.taskId) || undefined;
    const existingFlow = taskId
      ? taskId
      : (await this.correlation.resolveFlowBySessionAgent(sessionId, agentId) || undefined);
    const flowId = existingFlow || `flow-${sessionId}-${agentId}`;
    await this.correlation.upsertFlow({
      flowId,
      ...(taskId ? { taskId } : {}),
    });
    await this.correlation.bindSessionAgentFlow(sessionId, agentId, flowId);
    const next = await this.correlation.nextSeq(flowId);

    const phase = type === 'task_completed' || type === 'task_failed'
      ? 'completion'
      : 'execution';

    const output: ExecutionUpdateEvent = {
      id: `exeupd-${Date.now().toString(36)}-${randomId(8)}`,
      ts: asString(event.timestamp) || new Date().toISOString(),
      seq: next.seq,
      flowId,
      traceId: next.traceId,
      ...(taskId || next.taskId ? { taskId: taskId || next.taskId } : {}),
      sessionId,
      sourceAgentId: agentId,
      sourceType: normalizeSourceType({ sourceAgentId: agentId }),
      phase,
      kind: type === 'task_failed' ? 'error' : 'status',
      level: type === 'task_failed'
        ? 'critical'
        : (type === 'task_started' || type === 'task_completed' ? 'milestone' : 'info'),
      payload: {
        eventType: type,
        ...(typeof payload.progress === 'number' ? { progress: payload.progress } : {}),
        ...(asString(payload.message) ? { message: asString(payload.message) } : {}),
        ...(asString(payload.title) ? { title: asString(payload.title) } : {}),
        ...(asString(payload.error) ? { error: asString(payload.error) } : {}),
        ...(type === 'task_blocked' && asString(payload.reason) ? { reason: asString(payload.reason) } : {}),
      },
    };
    await this.eventStore.append(output);
  }

  private async handleProgressEvent(event: Record<string, unknown>, type: string): Promise<void> {
    const payload = sanitizePayload(event.payload);
    const sessionId = asString(event.sessionId) || 'default';
    const agentId = this.resolveLifecycleAgent(sessionId);
    const flowId = await this.correlation.resolveFlowBySessionAgent(sessionId, agentId) || `flow-${sessionId}-${agentId}`;
    await this.correlation.upsertFlow({ flowId });
    await this.correlation.bindSessionAgentFlow(sessionId, agentId, flowId);
    const next = await this.correlation.nextSeq(flowId);
    const role = inferUpdateStreamRole(agentId);
    const phase = role === 'system' ? 'review' : 'execution';
    const level = type === 'plan_updated' ? 'milestone' : 'info';
    const output: ExecutionUpdateEvent = {
      id: `exeupd-${Date.now().toString(36)}-${randomId(8)}`,
      ts: asString(event.timestamp) || new Date().toISOString(),
      seq: next.seq,
      flowId,
      traceId: next.traceId,
      ...(next.taskId ? { taskId: next.taskId } : {}),
      sessionId,
      sourceAgentId: agentId,
      sourceType: normalizeSourceType({ sourceAgentId: agentId }),
      phase,
      kind: 'status',
      level,
      payload: {
        eventType: type,
        ...payload,
      },
    };
    await this.eventStore.append(output);
  }

  private async handleAssistantComplete(event: Record<string, unknown>): Promise<void> {
    const payload = sanitizePayload(event.payload);
    const sessionId = asString(event.sessionId) || 'default';
    const agentId = asString(event.agentId) || this.resolveLifecycleAgent(sessionId);
    const flowId = await this.correlation.resolveFlowBySessionAgent(sessionId, agentId) || `flow-${sessionId}-${agentId}`;
    await this.correlation.upsertFlow({ flowId });
    await this.correlation.bindSessionAgentFlow(sessionId, agentId, flowId);
    const next = await this.correlation.nextSeq(flowId);
    const finishReason = asString(payload.stopReason) || undefined;
    const output: ExecutionUpdateEvent = {
      id: `exeupd-${Date.now().toString(36)}-${randomId(8)}`,
      ts: asString(event.timestamp) || new Date().toISOString(),
      seq: next.seq,
      flowId,
      traceId: next.traceId,
      ...(next.taskId ? { taskId: next.taskId } : {}),
      sessionId,
      sourceAgentId: agentId,
      sourceType: normalizeSourceType({ sourceAgentId: agentId }),
      phase: 'completion',
      kind: 'status',
      level: finishReason === 'stop' ? 'milestone' : 'info',
      ...(finishReason ? { finishReason } : {}),
      payload: {
        eventType: 'assistant_complete',
        ...(asString(payload.messageId) ? { messageId: asString(payload.messageId) } : {}),
        ...(finishReason ? { finishReason } : {}),
      },
    };
    await this.eventStore.append(output);
  }

  private async handleTurnComplete(event: Record<string, unknown>): Promise<void> {
    const payload = sanitizePayload(event.payload);
    const sessionId = asString(event.sessionId) || 'default';
    const lifecycleAgent = this.resolveLifecycleAgent(sessionId);
    const flowId = await this.correlation.resolveFlowBySessionAgent(sessionId, lifecycleAgent) || `flow-${sessionId}-${lifecycleAgent}`;
    await this.correlation.upsertFlow({ flowId });
    await this.correlation.bindSessionAgentFlow(sessionId, lifecycleAgent, flowId);
    const next = await this.correlation.nextSeq(flowId);
    const finishReason = asString(payload.finishReason) || undefined;
    const output: ExecutionUpdateEvent = {
      id: `exeupd-${Date.now().toString(36)}-${randomId(8)}`,
      ts: asString(event.timestamp) || new Date().toISOString(),
      seq: next.seq,
      flowId,
      traceId: next.traceId,
      ...(next.taskId ? { taskId: next.taskId } : {}),
      sessionId,
      sourceAgentId: lifecycleAgent,
      sourceType: normalizeSourceType({ sourceAgentId: lifecycleAgent }),
      phase: 'completion',
      kind: 'status',
      level: finishReason === 'stop' ? 'milestone' : 'info',
      ...(finishReason ? { finishReason } : {}),
      payload: {
        ...(finishReason ? { finishReason } : {}),
      },
    };
    await this.eventStore.append(output);
  }

  private async handleKernelReasoning(event: Record<string, unknown>): Promise<void> {
    const payload = sanitizePayload(event.payload);
    const sessionId = asString(event.sessionId) || 'default';
    const text = asString(payload.text);
    if (!text) return;
    const agentId = asString(payload.agentId) || this.resolveLifecycleAgent(sessionId);
    const flowId = await this.correlation.resolveFlowBySessionAgent(sessionId, agentId) || `flow-${sessionId}-${agentId}`;
    await this.correlation.upsertFlow({ flowId });
    await this.correlation.bindSessionAgentFlow(sessionId, agentId, flowId);
    const next = await this.correlation.nextSeq(flowId);
    const output: ExecutionUpdateEvent = {
      id: `exeupd-${Date.now().toString(36)}-${randomId(8)}`,
      ts: asString(event.timestamp) || new Date().toISOString(),
      seq: next.seq,
      flowId,
      traceId: next.traceId,
      ...(next.taskId ? { taskId: next.taskId } : {}),
      sessionId,
      sourceAgentId: agentId,
      sourceType: normalizeSourceType({ sourceAgentId: agentId }),
      phase: 'execution',
      kind: 'reasoning',
      level: 'debug',
      payload: {
        text: text.slice(0, 400),
        roleProfile: asString(payload.roleProfile) || undefined,
      },
    };
    await this.eventStore.append(output);
  }
  private resolveLifecycleAgent(sessionId: string): string {
    const session = this.deps.sessionManager.getSession(sessionId);
    const context = session?.context && typeof session.context === 'object'
      ? session.context as Record<string, unknown>
      : {};
    const executionLifecycle = context.executionLifecycle && typeof context.executionLifecycle === 'object'
      ? context.executionLifecycle as Record<string, unknown>
      : {};
    return asString(executionLifecycle.targetAgentId)
      || asString(context.ownerAgentId)
      || 'finger-system-agent';
  }
}
