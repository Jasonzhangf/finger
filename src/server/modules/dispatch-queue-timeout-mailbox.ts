import { extractTaskText } from '../../common/agent-dispatch.js';
import type {
  AgentAssignmentLifecycle,
  DispatchQueueTimeoutFallbackResult,
} from '../../blocks/agent-runtime-block/index.js';
import { heartbeatMailbox } from './heartbeat-mailbox.js';
import { buildQueuedDispatchEnvelope } from './mailbox-envelope.js';

export function fallbackDispatchQueueTimeoutToMailbox(params: {
  dispatchId: string;
  sourceAgentId: string;
  targetAgentId: string;
  sessionId?: string;
  workflowId?: string;
  assignment?: AgentAssignmentLifecycle;
  task: unknown;
  metadata?: Record<string, unknown>;
}): DispatchQueueTimeoutFallbackResult {
  const taskText = extractTaskText(params.task);
  const envelope = buildQueuedDispatchEnvelope({
    dispatchId: params.dispatchId,
    sourceAgentId: params.sourceAgentId,
    targetAgentId: params.targetAgentId,
    sessionId: params.sessionId,
    workflowId: params.workflowId,
    taskText,
    assignment: params.assignment,
  });

  const appended = heartbeatMailbox.append(params.targetAgentId, {
    type: 'dispatch-task',
    dispatchId: params.dispatchId,
    sourceAgentId: params.sourceAgentId,
    targetAgentId: params.targetAgentId,
    sessionId: params.sessionId,
    workflowId: params.workflowId,
    assignment: params.assignment,
    prompt: taskText,
    envelope,
    requiresAck: true,
  }, {
    sender: params.sourceAgentId,
    sessionId: params.sessionId,
    channel: typeof params.metadata?.channelId === 'string' ? params.metadata.channelId : undefined,
    sourceType: 'control',
    category: 'dispatch-task',
    priority: 0,
    deliveryPolicy: 'realtime',
  });

  return {
    delivery: 'mailbox',
    mailboxMessageId: appended.id,
    summary: `Target busy timeout; task moved to mailbox (${appended.id}) for ${params.targetAgentId}`,
    nextAction: 'Wait for the target agent to call mailbox.read(...) and then mailbox.ack(..., {summary/result or error}) after it becomes available.',
  };
}
