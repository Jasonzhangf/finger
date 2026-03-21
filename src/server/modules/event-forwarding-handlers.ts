/**
 * Event Forwarding Handlers - WebSocket broadcast event subscriptions
 *
 * Separated from event-forwarding.ts to keep file under 500 lines.
 * Contains all eventBus.subscribe* calls that broadcast to WebSocket clients.
 */

import { logger } from '../../core/logger.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import type { AgentStepCompletedEvent, ToolCallEvent, ToolErrorEvent, ToolResultEvent } from '../../runtime/events.js';
import { buildAgentStepContent } from './event-forwarding-helpers.js';

const log = logger.module('event-forwarding-handlers');

type SessionEventRecord = {
  type: 'tool_call' | 'tool_result' | 'tool_error' | 'agent_step' | 'reasoning';
  agentId?: string;
  toolName?: string;
  toolStatus?: 'success' | 'error';
  toolDurationMs?: number;
  toolInput?: unknown;
  toolOutput?: unknown;
  metadata?: Record<string, unknown>;
};

export interface HandlerDeps {
  eventBus: UnifiedEventBus;
  broadcast: (msg: unknown) => void;
  generalAgentId: string;
  persistSessionEventMessage: (
    sessionId: string,
    content: string,
    detail: SessionEventRecord,
    role?: 'user' | 'assistant' | 'system' | 'orchestrator'
  ) => void;
}

export function attachBroadcastHandlers(deps: HandlerDeps): void {
  const { eventBus, broadcast, generalAgentId, persistSessionEventMessage } = deps;

  // ── Workflow task events ──
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

  log.info('EventBus subscription enabled: task_started, task_completed, task_failed, workflow_progress, phase_transition');

  // ── Agent update (detailed) ──
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

  // ── Agent update (generic step) ──
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

  log.info('EventBus agent forwarding enabled: agent_thought, agent_action, agent_observation, agent_step_completed');

  // ── Tool events ──
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

  // tool_error broadcast to WebSocket/QQBot
  eventBus.subscribe('tool_error', (event) => {
    if (event.type !== 'tool_error') return;
    const toolEvent = event as ToolErrorEvent;
    broadcast({
      type: 'tool_error',
      sessionId: toolEvent.sessionId,
      agentId: toolEvent.agentId,
      timestamp: event.timestamp,
      payload: {
        toolId: toolEvent.toolId,
        toolName: toolEvent.toolName,
        error: toolEvent.payload?.error ?? 'unknown',
        ...(typeof toolEvent.payload?.duration === 'number' ? { duration: toolEvent.payload.duration } : {}),
      },
    });
  });

  // ── Agent step completed ──
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

  eventBus.subscribe('agent_step_completed', (event) => {
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
  });

  log.info('EventBus agent_step_completed forwarding enabled for detailed agent updates');
}
