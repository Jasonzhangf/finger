import { isObjectRecord } from '../../common/object.js';
import type { AgentControlRequest, AgentDispatchRequest, AgentRuntimeDeps } from './types.js';

export function parseAgentDispatchToolInput(rawInput: unknown, deps: AgentRuntimeDeps): AgentDispatchRequest {
  if (!isObjectRecord(rawInput)) {
    throw new Error('agent.dispatch input must be object');
  }
  const sourceAgentId = typeof rawInput.source_agent_id === 'string'
    ? rawInput.source_agent_id
    : typeof rawInput.sourceAgentId === 'string'
      ? rawInput.sourceAgentId
      : deps.primaryOrchestratorAgentId;
  const targetAgentId = typeof rawInput.target_agent_id === 'string'
    ? rawInput.target_agent_id
    : typeof rawInput.targetAgentId === 'string'
      ? rawInput.targetAgentId
      : '';
  const task = rawInput.task ?? rawInput.input ?? rawInput.message;
  if (!targetAgentId || targetAgentId.trim().length === 0) {
    throw new Error('agent.dispatch target_agent_id is required');
  }
  if (task === undefined) {
    throw new Error('agent.dispatch task is required');
  }
  const sessionId = typeof rawInput.session_id === 'string'
    ? rawInput.session_id
    : typeof rawInput.sessionId === 'string'
      ? rawInput.sessionId
      : deps.runtime.getCurrentSession()?.id;
  const workflowId = typeof rawInput.workflow_id === 'string'
    ? rawInput.workflow_id
    : typeof rawInput.workflowId === 'string'
      ? rawInput.workflowId
      : undefined;
  const blocking = rawInput.blocking === true;
  const queueOnBusy = rawInput.queue_on_busy !== false && rawInput.queueOnBusy !== false;
  const maxQueueWaitMs = typeof rawInput.max_queue_wait_ms === 'number'
    ? rawInput.max_queue_wait_ms
    : typeof rawInput.maxQueueWaitMs === 'number'
      ? rawInput.maxQueueWaitMs
      : undefined;
  const assignmentInput = isObjectRecord(rawInput.assignment) ? rawInput.assignment : undefined;
  if (!assignmentInput) {
    return {
      sourceAgentId: sourceAgentId.trim().length > 0 ? sourceAgentId.trim() : deps.primaryOrchestratorAgentId,
      targetAgentId: targetAgentId.trim(),
      task,
      ...(typeof sessionId === 'string' && sessionId.trim().length > 0 ? { sessionId: sessionId.trim() } : {}),
      ...(typeof workflowId === 'string' && workflowId.trim().length > 0 ? { workflowId: workflowId.trim() } : {}),
      blocking,
      queueOnBusy,
      ...(typeof maxQueueWaitMs === 'number' && Number.isFinite(maxQueueWaitMs)
        ? { maxQueueWaitMs: Math.max(1_000, Math.floor(maxQueueWaitMs)) }
        : {}),
      ...(isObjectRecord(rawInput.metadata) ? { metadata: rawInput.metadata } : {}),
    };
  }
  const assignment = {
    ...(typeof assignmentInput.epic_id === 'string'
      ? { epicId: assignmentInput.epic_id }
      : typeof assignmentInput.epicId === 'string'
        ? { epicId: assignmentInput.epicId }
        : {}),
    ...(typeof assignmentInput.task_id === 'string'
      ? { taskId: assignmentInput.task_id }
      : typeof assignmentInput.taskId === 'string'
        ? { taskId: assignmentInput.taskId }
        : {}),
    ...(typeof assignmentInput.bd_task_id === 'string'
      ? { bdTaskId: assignmentInput.bd_task_id }
      : typeof assignmentInput.bdTaskId === 'string'
        ? { bdTaskId: assignmentInput.bdTaskId }
        : {}),
    ...(typeof assignmentInput.assigner_agent_id === 'string'
      ? { assignerAgentId: assignmentInput.assigner_agent_id }
      : typeof assignmentInput.assignerAgentId === 'string'
        ? { assignerAgentId: assignmentInput.assignerAgentId }
        : {}),
    ...(typeof assignmentInput.assignee_agent_id === 'string'
      ? { assigneeAgentId: assignmentInput.assignee_agent_id }
      : typeof assignmentInput.assigneeAgentId === 'string'
        ? { assigneeAgentId: assignmentInput.assigneeAgentId }
        : {}),
    ...(typeof assignmentInput.phase === 'string'
      ? { phase: assignmentInput.phase as NonNullable<AgentDispatchRequest['assignment']>['phase'] }
      : {}),
    ...(typeof assignmentInput.attempt === 'number' && Number.isFinite(assignmentInput.attempt)
      ? { attempt: Math.max(1, Math.floor(assignmentInput.attempt)) }
      : {}),
  };
  return {
    sourceAgentId: sourceAgentId.trim().length > 0 ? sourceAgentId.trim() : deps.primaryOrchestratorAgentId,
    targetAgentId: targetAgentId.trim(),
    task,
    ...(typeof sessionId === 'string' && sessionId.trim().length > 0 ? { sessionId: sessionId.trim() } : {}),
    ...(typeof workflowId === 'string' && workflowId.trim().length > 0 ? { workflowId: workflowId.trim() } : {}),
    blocking,
    queueOnBusy,
    ...(typeof maxQueueWaitMs === 'number' && Number.isFinite(maxQueueWaitMs)
      ? { maxQueueWaitMs: Math.max(1_000, Math.floor(maxQueueWaitMs)) }
      : {}),
    ...(Object.keys(assignment).length > 0 ? { assignment } : {}),
    ...(isObjectRecord(rawInput.metadata) ? { metadata: rawInput.metadata } : {}),
  };
}

export function parseAgentControlToolInput(rawInput: unknown): AgentControlRequest {
  if (!isObjectRecord(rawInput)) {
    throw new Error('agent.control input must be object');
  }
  const rawAction = typeof rawInput.action === 'string' ? rawInput.action.trim().toLowerCase() : '';
  if (!rawAction) {
    throw new Error('agent.control action is required');
  }
  if (rawAction !== 'status' && rawAction !== 'pause' && rawAction !== 'resume' && rawAction !== 'interrupt' && rawAction !== 'cancel') {
    throw new Error('agent.control action must be status|pause|resume|interrupt|cancel');
  }
  const request: AgentControlRequest = {
    action: rawAction,
    ...(typeof rawInput.target_agent_id === 'string'
      ? { targetAgentId: rawInput.target_agent_id }
      : typeof rawInput.targetAgentId === 'string'
        ? { targetAgentId: rawInput.targetAgentId }
        : {}),
    ...(typeof rawInput.session_id === 'string'
      ? { sessionId: rawInput.session_id }
      : typeof rawInput.sessionId === 'string'
        ? { sessionId: rawInput.sessionId }
        : {}),
    ...(typeof rawInput.workflow_id === 'string'
      ? { workflowId: rawInput.workflow_id }
      : typeof rawInput.workflowId === 'string'
        ? { workflowId: rawInput.workflowId }
        : {}),
    ...(typeof rawInput.provider_id === 'string'
      ? { providerId: rawInput.provider_id }
      : typeof rawInput.providerId === 'string'
        ? { providerId: rawInput.providerId }
        : {}),
    ...(typeof rawInput.hard === 'boolean' ? { hard: rawInput.hard } : {}),
  };
  return request;
}

export function parseAgentDeployToolInput(rawInput: unknown): Record<string, unknown> {
  if (!isObjectRecord(rawInput)) {
    throw new Error('agent.deploy input must be object');
  }
  const targetAgentId = typeof rawInput.target_agent_id === 'string'
    ? rawInput.target_agent_id.trim()
    : typeof rawInput.targetAgentId === 'string'
      ? rawInput.targetAgentId.trim()
      : '';
  const instanceCountRaw = typeof rawInput.instance_count === 'number'
    ? rawInput.instance_count
    : typeof rawInput.instanceCount === 'number'
      ? rawInput.instanceCount
      : 1;
  const config = isObjectRecord(rawInput.config) ? rawInput.config : {};
  const provider = typeof rawInput.provider === 'string' ? rawInput.provider : undefined;
  const request: Record<string, unknown> = {
    ...(targetAgentId.length > 0 ? { targetAgentId } : {}),
    ...(Number.isFinite(instanceCountRaw) ? { instanceCount: Math.max(1, Math.floor(instanceCountRaw)) } : {}),
    ...(provider ? { config: { ...config, provider } } : { config }),
    ...(typeof rawInput.session_id === 'string'
      ? { sessionId: rawInput.session_id }
      : typeof rawInput.sessionId === 'string'
        ? { sessionId: rawInput.sessionId }
        : {}),
    ...(typeof rawInput.scope === 'string' && (rawInput.scope === 'session' || rawInput.scope === 'global')
      ? { scope: rawInput.scope }
      : {}),
    ...(typeof rawInput.launch_mode === 'string' && (rawInput.launch_mode === 'manual' || rawInput.launch_mode === 'orchestrator')
      ? { launchMode: rawInput.launch_mode }
      : typeof rawInput.launchMode === 'string' && (rawInput.launchMode === 'manual' || rawInput.launchMode === 'orchestrator')
        ? { launchMode: rawInput.launchMode }
        : {}),
    ...(typeof rawInput.target_implementation_id === 'string'
      ? { targetImplementationId: rawInput.target_implementation_id }
      : typeof rawInput.targetImplementationId === 'string'
        ? { targetImplementationId: rawInput.targetImplementationId }
        : {}),
  };

  const configRecord = isObjectRecord(request.config) ? request.config : null;
  const hasConfigIdentity = configRecord !== null && (
    (typeof configRecord.id === 'string' && configRecord.id.trim().length > 0)
    || (typeof configRecord.name === 'string' && configRecord.name.trim().length > 0)
  );
  if (!targetAgentId && !hasConfigIdentity) {
    throw new Error('agent.deploy target_agent_id or config.id/config.name is required');
  }

  return request;
}
