import { logger } from '../../../core/logger.js';
import { isObjectRecord } from '../../../server/common/object.js';
import { asString, firstNonEmptyString } from '../../../server/common/strings.js';
import { getGlobalDispatchTracker } from '../../../server/modules/agent-runtime/dispatch-tracker.js';
import { sanitizeDispatchResult, type DispatchSummaryResult } from '../../../common/agent-dispatch.js';
import type { AgentDispatchRequest, AgentRuntimeDeps } from '../../../server/modules/agent-runtime/types.js';
import {
  enrichDispatchTagsAndTopic,
  normalizeProjectPathHint,
} from '../../../server/modules/agent-runtime/dispatch-helpers.js';
import { normalizeDispatchTargetAgentId } from '../../../server/modules/agent-runtime/dispatch-target-normalization.js';
import {
  FINGER_PROJECT_AGENT_ID,
  FINGER_SYSTEM_AGENT_ID,
} from '../../../agents/finger-general/finger-general-module.js';
import {
  isProjectTaskStateActive,
  normalizeBlockedByForTaskState,
  parseDelegatedProjectTaskRegistry,
  parseProjectTaskState,
} from '../../../common/project-task-state.js';
import { resolveAgentDisplayName } from '../../../server/modules/agent-name-resolver.js';
import { applyProjectStatusGatewayPatch } from '../../../server/modules/project-status-gateway.js';
import { listAgents, setMonitorStatus } from '../../../agents/finger-system-agent/registry.js';
import {
  applyExecutionLifecycleTransition,
  getExecutionLifecycleState,
  resolveLifecycleStageFromResultStatus,
} from '../../../server/modules/execution-lifecycle.js';
import {
  applySessionProgressDeliveryFromDispatch,
  bindDispatchSessionToRuntime,
  persistAgentSummaryToMemory,
  persistDispatchUserMessage,
  persistUserMessageToMemory,
  resolveAutoDeployInstanceCount,
  resolveDispatchSessionSelection,
  resolveRetryBackoffMs,
  shouldUseTransientLedgerForDispatch,
  shouldAutoDeployForMissingTarget,
  sleep,
  syncBdDispatchLifecycle,
  withDispatchWorkspaceDefaults,
} from '../../../server/modules/agent-runtime/dispatch-runtime-helpers.js';
import { loadUserSettings, resolveAutonomyModeForRole } from '../../../core/user-settings.js';
import { loadOrchestrationConfig } from '../../../orchestration/orchestration-config.js';
import { fallbackDispatchQueueTimeoutToMailbox } from '../../../server/modules/dispatch-queue-timeout-mailbox.js';
import {
  extractKernelMetadataFromAgentResult,
  extractResultTextForSession,
  kernelMetadataHasCompactedProjection,
} from '../../../server/modules/message-session.js';

const DISPATCH_ERROR_MAX_RETRIES = Number.isFinite(Number(process.env.FINGER_DISPATCH_ERROR_MAX_RETRIES))
  ? Math.max(0, Math.floor(Number(process.env.FINGER_DISPATCH_ERROR_MAX_RETRIES)))
  : 2; // Reduced from 10: prevents retry amplification under provider timeout storms
const HEARTBEAT_SOURCE_AGENT_ID = 'system-heartbeat';
const BLOCKED_BY_NONE = 'none';
const BUSY_RUNTIME_STATUSES = new Set(['running', 'queued', 'waiting_input', 'paused']);
const ACTIVE_PROJECT_LIFECYCLE_STAGES = new Set([
  'received',
  'session_bound',
  'dispatching',
  'running',
  'waiting_tool',
  'waiting_model',
  'retrying',
  'interrupted',
]);
const DISPATCH_BLOCKED_BY_OPTIONAL_SOURCES = new Set([
  'system-heartbeat',
  'mailbox-check',
  'project-task-update',
  'project-delivery-report',
  'project-delivery-continue',
  'review-reject-redispatch',
  'task-report',
]);

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseBooleanFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'n') return false;
  return undefined;
}

function isProjectScopedDispatchTargetId(targetAgentId: string): boolean {
  const id = asTrimmedString(targetAgentId).toLowerCase();
  return id.includes('project') || id.includes('agent') || id.includes('general') || id.includes('orchestr');
}

function shouldGuaranteeDispatchToTasklist(input: AgentDispatchRequest): boolean {
  const source = asTrimmedString(input.sourceAgentId);
  const target = asTrimmedString(input.targetAgentId);
  if (!source || !target) return false;
  if (source === target) return false;
  return source.startsWith('finger-') && target.startsWith('finger-');
}

function buildGuaranteedQueuedDispatchResult(params: {
  dispatchId: string;
  reason: string;
  originalStatus?: string;
}): {
  ok: boolean;
  dispatchId: string;
  status: 'queued';
  result: DispatchSummaryResult;
} {
  const summary = [
    'Dispatch normalized to queued tasklist state.',
    params.reason,
  ].filter(Boolean).join(' ');
  return {
    ok: true,
    dispatchId: params.dispatchId,
    status: 'queued',
    result: sanitizeDispatchResult({
      success: true,
      status: 'queued_tasklist',
      summary,
      recoveryAction: 'tasklist_queue',
      delivery: 'queue',
      ...(params.originalStatus ? { nextAction: `normalized_from_${params.originalStatus}` } : {}),
    }),
  };
}

async function buildGuaranteedQueuedDispatchResultWithMailbox(
  deps: AgentRuntimeDeps,
  input: AgentDispatchRequest,
  params: {
    dispatchId: string;
    reason: string;
    originalStatus?: string;
  },
): Promise<{
  ok: boolean;
  dispatchId: string;
  status: 'queued';
  result: DispatchSummaryResult;
}> {
  const targetAgentId = asTrimmedString(input.targetAgentId);
  const sourceAgentId = firstNonEmptyString(
    asTrimmedString(input.sourceAgentId),
    asTrimmedString(deps.primaryOrchestratorAgentId),
    FINGER_SYSTEM_AGENT_ID,
  ) ?? FINGER_SYSTEM_AGENT_ID;
  const sessionId = asTrimmedString(input.sessionId);
  const workflowId = asTrimmedString(input.workflowId);
  if (!targetAgentId) {
    return buildGuaranteedQueuedDispatchResult(params);
  }

  try {
    const fallback = fallbackDispatchQueueTimeoutToMailbox({
      dispatchId: params.dispatchId,
      sourceAgentId,
      targetAgentId,
      sessionId: sessionId || undefined,
      workflowId: workflowId || undefined,
      assignment: isObjectRecord(input.assignment) ? input.assignment as AgentDispatchRequest['assignment'] : undefined,
      task: input.task,
      metadata: isObjectRecord(input.metadata) ? input.metadata : undefined,
    });
    const nextAction = params.originalStatus
      ? `normalized_from_${params.originalStatus}`
      : fallback.nextAction;
    const summary = [
      'Dispatch guaranteed via mailbox queue persistence.',
      params.reason,
      `message_id=${fallback.mailboxMessageId}`,
    ].filter(Boolean).join(' ');
    const wakePrompt = [
      `High-priority mailbox task enqueued (messageId=${fallback.mailboxMessageId}).`,
      'Immediately consume this mailbox task before unrelated work.',
      `Required action: mailbox.read("${fallback.mailboxMessageId}") then mailbox.ack("${fallback.mailboxMessageId}", { summary/result or error }).`,
      'If currently busy, keep this as next runnable item (pending-input style merge semantics).',
    ].join('\n');
    let wakeAttempted = false;
    let wakeQueued = false;
    let wakeError = '';
    try {
      wakeAttempted = true;
      const wakeResult = await deps.agentRuntimeBlock.execute('dispatch', {
        sourceAgentId,
        targetAgentId,
        task: wakePrompt,
        queueOnBusy: true,
        maxQueueWaitMs: 0,
        blocking: false,
        metadata: {
          source: 'mailbox-check',
          sourceType: 'mailbox',
          role: 'system',
          systemDirectInject: true,
          deliveryMode: 'direct',
          mailboxMessageId: fallback.mailboxMessageId,
          mailboxPriority: 0,
          mailboxHighPriority: true,
        },
      } as unknown as Record<string, unknown>) as {
        status?: string;
      };
      wakeQueued = typeof wakeResult?.status === 'string'
        && (wakeResult.status === 'queued' || wakeResult.status === 'completed');
    } catch (error) {
      wakeError = error instanceof Error ? error.message : String(error);
      logger.module('dispatch').warn('High-priority mailbox wake dispatch failed; mailbox task remains persisted', {
        dispatchId: params.dispatchId,
        sourceAgentId,
        targetAgentId,
        sessionId: sessionId || undefined,
        mailboxMessageId: fallback.mailboxMessageId,
        error: wakeError,
      });
    }

    return {
      ok: true,
      dispatchId: params.dispatchId,
      status: 'queued',
      result: sanitizeDispatchResult({
        success: true,
        status: 'queued_mailbox',
        summary,
        recoveryAction: 'mailbox',
        delivery: 'mailbox',
        messageId: fallback.mailboxMessageId,
        wakeAttempted,
        wakeQueued,
        ...(wakeError ? { wakeError } : {}),
        ...(nextAction ? { nextAction } : {}),
      }),
    };
  } catch (error) {
    logger.module('dispatch').warn('Guaranteed mailbox queue fallback failed; degrading to queued tasklist summary', {
      dispatchId: params.dispatchId,
      sourceAgentId,
      targetAgentId,
      sessionId: sessionId || undefined,
      error: error instanceof Error ? error.message : String(error),
    });
    return buildGuaranteedQueuedDispatchResult(params);
  }
}

function isNonRetriableDispatchFailure(error: unknown): boolean {
  const text = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : String(error ?? '');
  const normalized = text.toLowerCase();
  return (
    normalized.includes('session_binding_scope_violation')
    || normalized.includes('session_binding_mismatch')
    || normalized.includes('dispatch session/project scope mismatch')
    || normalized.includes('project agent cannot run on system-owned session')
  );
}

function isSystemOwnedSession(deps: AgentRuntimeDeps, sessionId: string): boolean {
  const session = deps.sessionManager.getSession(sessionId);
  if (!session) return false;
  const context = isObjectRecord(session.context) ? session.context : {};
  const ownerAgentId = asString(context.ownerAgentId);
  const sessionTier = asString(context.sessionTier);
  return (
    sessionId.startsWith('system-')
    || sessionId.startsWith('review-')
    || sessionId.startsWith('hb-')
    || sessionTier === 'system'
    || ownerAgentId === FINGER_SYSTEM_AGENT_ID
  );
}

function resolveAutonomyRoleFromTargetAgent(targetAgentId: string): 'system' | 'project' {
  const normalized = asTrimmedString(targetAgentId).toLowerCase();
  if (normalized === FINGER_SYSTEM_AGENT_ID || normalized.includes('system')) return 'system';
  return 'project';
}

interface ProjectWorkerCandidate {
  id: string;
  name: string;
  order: number;
}

interface WorkerLoadSnapshot {
  runningCount: number;
  queuedCount: number;
}

const PROJECT_WORKER_ROUND_ROBIN_CURSOR = new Map<string, number>();

export function __resetProjectWorkerRoundRobinCursorForTest(): void {
  PROJECT_WORKER_ROUND_ROBIN_CURSOR.clear();
}

function listEnabledProjectWorkers(): ProjectWorkerCandidate[] {
  try {
    const loaded = loadOrchestrationConfig();
    const workers = loaded.config.runtime?.projectWorkers?.workers ?? [];
    const candidates = workers
      .map((worker, index) => ({
        id: asTrimmedString(worker.id),
        name: asTrimmedString(worker.name) || asTrimmedString(worker.id) || 'project-worker',
        enabled: worker.enabled !== false,
        order: index,
      }))
      .filter((worker) => worker.enabled && worker.id.length > 0)
      .map((worker) => ({ id: worker.id, name: worker.name, order: worker.order }));
    if (candidates.length > 0) return candidates;
  } catch (error) {
    logger.module('dispatch').warn('Failed to load project worker config; using default worker fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return [{ id: FINGER_PROJECT_AGENT_ID, name: resolveAgentDisplayName(FINGER_PROJECT_AGENT_ID), order: 0 }];
}

function resolveExplicitAssigneeWorkerId(input: AgentDispatchRequest): string {
  const assignment: Record<string, unknown> = isObjectRecord(input.assignment) ? input.assignment : {};
  const metadata: Record<string, unknown> = isObjectRecord(input.metadata) ? input.metadata : {};
  const taskRecord: Record<string, unknown> = isObjectRecord(input.task) ? input.task : {};
  const taskMetadata: Record<string, unknown> = isObjectRecord(taskRecord.metadata) ? taskRecord.metadata : {};
  return firstNonEmptyString(
    asString(assignment.assigneeWorkerId),
    asString(assignment.assignee_worker_id),
    asString(assignment.assigneeAgentId),
    asString(metadata.assigneeWorkerId),
    asString(metadata.assignee_worker_id),
    asString(metadata.workerId),
    asString(metadata.worker_id),
    asString(taskMetadata.assigneeWorkerId),
    asString(taskMetadata.assignee_worker_id),
    asString(taskMetadata.workerId),
    asString(taskMetadata.worker_id),
  ) ?? '';
}

function addWorkerLoad(
  map: Map<string, WorkerLoadSnapshot>,
  workerId: string,
  running: number,
  queued: number,
): void {
  if (!workerId) return;
  const current = map.get(workerId) ?? { runningCount: 0, queuedCount: 0 };
  const nextRunning = Number.isFinite(running) ? Math.max(0, Math.floor(running)) : 0;
  const nextQueued = Number.isFinite(queued) ? Math.max(0, Math.floor(queued)) : 0;
  map.set(workerId, {
    runningCount: current.runningCount + nextRunning,
    queuedCount: current.queuedCount + nextQueued,
  });
}

function readWorkerLoadFromRuntimeView(
  runtimeView: unknown,
  candidateWorkerIds: Set<string>,
): Map<string, WorkerLoadSnapshot> {
  const loads = new Map<string, WorkerLoadSnapshot>();
  if (!isObjectRecord(runtimeView)) return loads;
  const lanes = Array.isArray(runtimeView.lanes) ? runtimeView.lanes : [];
  for (const lane of lanes) {
    if (!isObjectRecord(lane)) continue;
    const agentId = asTrimmedString(lane.agentId);
    if (agentId && agentId !== FINGER_PROJECT_AGENT_ID) continue;
    const workerId = asTrimmedString(lane.workerId);
    if (!workerId || !candidateWorkerIds.has(workerId)) continue;
    const runningCount = typeof lane.runningCount === 'number' ? lane.runningCount : Number(lane.runningCount);
    const queuedCount = typeof lane.queuedCount === 'number' ? lane.queuedCount : Number(lane.queuedCount);
    addWorkerLoad(loads, workerId, runningCount, queuedCount);
  }
  return loads;
}

function selectLeastLoadedProjectWorker(
  candidates: ProjectWorkerCandidate[],
  loads: Map<string, WorkerLoadSnapshot>,
  roundRobinKey: string,
): ProjectWorkerCandidate {
  const withLoad = candidates.map((candidate) => {
    const load = loads.get(candidate.id) ?? { runningCount: 0, queuedCount: 0 };
    return {
      candidate,
      runningCount: load.runningCount,
      queuedCount: load.queuedCount,
      total: load.runningCount + load.queuedCount,
    };
  });
  const available = withLoad.filter((item) => item.total === 0);
  let pool = available;
  if (pool.length === 0) {
    const minTotal = Math.min(...withLoad.map((item) => item.total));
    pool = withLoad.filter((item) => item.total === minTotal);
    if (pool.length > 1) {
      const minRunning = Math.min(...pool.map((item) => item.runningCount));
      pool = pool.filter((item) => item.runningCount === minRunning);
    }
  }
  const ordered = [...pool].sort((a, b) => a.candidate.order - b.candidate.order);
  const rrKey = `${roundRobinKey}::${candidates.map((item) => item.id).join(',')}`;
  const currentCursor = PROJECT_WORKER_ROUND_ROBIN_CURSOR.get(rrKey) ?? 0;
  const selectedIndex = ordered.length > 0 ? (Math.max(0, currentCursor) % ordered.length) : 0;
  const selected = ordered[selectedIndex]?.candidate ?? candidates[0] ?? { id: FINGER_PROJECT_AGENT_ID, name: 'project-worker', order: 0 };
  if (ordered.length > 0) {
    PROJECT_WORKER_ROUND_ROBIN_CURSOR.set(rrKey, (selectedIndex + 1) % ordered.length);
  }
  return selected;
}

function applyWorkerSelectionToDispatchInput(
  input: AgentDispatchRequest,
  selectedWorker: ProjectWorkerCandidate,
  reason: 'explicit' | 'availability',
): AgentDispatchRequest {
  const assignment: Record<string, unknown> = isObjectRecord(input.assignment) ? { ...input.assignment } : {};
  const metadata: Record<string, unknown> = isObjectRecord(input.metadata) ? { ...input.metadata } : {};
  const taskRecord: Record<string, unknown> = isObjectRecord(input.task) ? { ...input.task } : {};
  const taskMetadata: Record<string, unknown> = isObjectRecord(taskRecord.metadata) ? { ...taskRecord.metadata } : {};

  assignment.assigneeWorkerId = selectedWorker.id;
  assignment.assigneeAgentId = selectedWorker.id;
  assignment.assigneeName = selectedWorker.name;
  assignment.assigneeWorkerName = selectedWorker.name;
  metadata.workerId = selectedWorker.id;
  metadata.assigneeWorkerId = selectedWorker.id;
  metadata.assigneeWorkerName = selectedWorker.name;
  metadata.workerPoolSelectionReason = reason;
  taskMetadata.workerId = selectedWorker.id;
  taskMetadata.assigneeWorkerId = selectedWorker.id;

  const nextTask = Object.keys(taskRecord).length === 0
    ? input.task
    : {
      ...taskRecord,
      metadata: taskMetadata,
    };

  return {
    ...input,
    assignment,
    metadata,
    task: nextTask,
  };
}

async function resolveSystemProjectDispatchWorker(
  deps: AgentRuntimeDeps,
  input: AgentDispatchRequest,
): Promise<{ input: AgentDispatchRequest; workerId?: string; workerName?: string; reason?: 'explicit' | 'availability' }> {
  if (!(input.sourceAgentId === FINGER_SYSTEM_AGENT_ID && input.targetAgentId === FINGER_PROJECT_AGENT_ID)) {
    return { input };
  }
  const explicitWorkerId = resolveExplicitAssigneeWorkerId(input);
  const candidates = listEnabledProjectWorkers();
  if (candidates.length === 0) return { input };
  if (explicitWorkerId) {
    const matched = candidates.find((worker) => worker.id === explicitWorkerId);
    const selected = matched ?? { id: explicitWorkerId, name: resolveAgentDisplayName(explicitWorkerId), order: candidates.length };
    return {
      input: applyWorkerSelectionToDispatchInput(input, selected, 'explicit'),
      workerId: selected.id,
      workerName: selected.name,
      reason: 'explicit',
    };
  }
  const candidateIds = new Set(candidates.map((item) => item.id));
  let workerLoads = new Map<string, WorkerLoadSnapshot>();
  try {
    const runtimeView = await deps.agentRuntimeBlock.execute('runtime_view', {});
    workerLoads = readWorkerLoadFromRuntimeView(runtimeView, candidateIds);
  } catch (error) {
    logger.module('dispatch').warn('Failed to read runtime_view for project worker load; continue with round-robin fallback', {
      error: error instanceof Error ? error.message : String(error),
      sourceAgentId: input.sourceAgentId,
      targetAgentId: input.targetAgentId,
    });
    workerLoads = new Map<string, WorkerLoadSnapshot>();
  }
  const projectPathHint = resolveDispatchProjectPathHint(input);
  const roundRobinKey = projectPathHint || 'global-project-dispatch';
  const selected = selectLeastLoadedProjectWorker(candidates, workerLoads, roundRobinKey);
  return {
    input: applyWorkerSelectionToDispatchInput(input, selected, 'availability'),
    workerId: selected.id,
    workerName: selected.name,
    reason: 'availability',
  };
}

function applyDispatchAutonomyDefaults(input: AgentDispatchRequest): AgentDispatchRequest {
  const metadata = isObjectRecord(input.metadata) ? { ...input.metadata } : {};
  if (typeof metadata.autonomyMode === 'string' || typeof metadata.yoloMode === 'boolean') {
    return {
      ...input,
      metadata,
    };
  }
  try {
    const settings = loadUserSettings();
    const role = resolveAutonomyRoleFromTargetAgent(input.targetAgentId);
    const mode = resolveAutonomyModeForRole(settings.preferences, role);
    metadata.autonomyMode = mode;
    metadata.yoloMode = mode === 'yolo';
    return {
      ...input,
      metadata,
    };
  } catch (error) {
    logger.module('dispatch').warn('Failed to load user settings for autonomy defaults; fallback to balanced mode', {
      targetAgentId: input.targetAgentId,
      error: error instanceof Error ? error.message : String(error),
    });
    metadata.autonomyMode = 'balanced';
    metadata.yoloMode = false;
    return {
      ...input,
      metadata,
    };
  }
}

function validateDispatchSessionScope(
  deps: AgentRuntimeDeps,
  input: AgentDispatchRequest,
): { ok: true } | { ok: false; error: string } {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (!sessionId) return { ok: true };
  const targetAgentId = asTrimmedString(input.targetAgentId);
  if (targetAgentId === FINGER_SYSTEM_AGENT_ID) return { ok: true };

  const session = deps.sessionManager.getSession(sessionId);
  if (!session) return { ok: true };
  const sessionProjectPath = normalizeProjectPathHint(
    typeof session.projectPath === 'string' ? session.projectPath : '',
  );
  const projectHintRaw = resolveDispatchProjectPathHint(input);
  const projectHint = normalizeProjectPathHint(projectHintRaw);

  if (projectHint && sessionProjectPath && projectHint !== sessionProjectPath) {
    return {
      ok: false,
      error: `dispatch session/project scope mismatch: session(${sessionId}) belongs to ${sessionProjectPath}, requested project ${projectHint}`,
    };
  }

  if (isProjectScopedDispatchTargetId(targetAgentId)) {
    const context = isObjectRecord(session.context) ? session.context : {};
    const ownerAgentId = asString(context.ownerAgentId);
    const sessionTier = asString(context.sessionTier);
    if (
      sessionId.startsWith('system-')
      || sessionId.startsWith('review-')
      || sessionId.startsWith('hb-')
      || sessionTier === 'system'
      || ownerAgentId === FINGER_SYSTEM_AGENT_ID
    ) {
      return {
        ok: false,
        error: `dispatch session/project scope mismatch: project agent cannot run on system-owned session ${sessionId}`,
      };
    }
  }

  return { ok: true };
}

function resolveDispatchTaskIdentity(input: AgentDispatchRequest): { taskId?: string; taskName?: string } {
  const assignment = isObjectRecord(input.assignment) ? input.assignment : {};
  const taskRecord = isObjectRecord(input.task) ? input.task : {};
  const taskId = firstNonEmptyString(
    asString(assignment.taskId),
    asString(taskRecord.taskId),
    asString(taskRecord.task_id),
  );
  const taskName = firstNonEmptyString(
    asString(assignment.taskName),
    asString(taskRecord.taskName),
    asString(taskRecord.task_name),
    asString(taskRecord.title),
    asString(taskRecord.name),
  );
  return {
    ...(taskId ? { taskId } : {}),
    ...(taskName ? { taskName } : {}),
  };
}

function resolveAssigneeWorkerIdFromDispatch(
  input: AgentDispatchRequest,
  currentState: ReturnType<typeof parseProjectTaskState>,
): string | undefined {
  const assignmentRecord: Record<string, unknown> = isObjectRecord(input.assignment) ? input.assignment : {};
  const metadata = isObjectRecord(input.metadata) ? input.metadata : {};
  const taskRecord = isObjectRecord(input.task) ? input.task : {};
  const taskMetadata = isObjectRecord(taskRecord.metadata) ? taskRecord.metadata : {};
  const raw = firstNonEmptyString(
    asString(assignmentRecord.assigneeWorkerId),
    asString(assignmentRecord.assignee_worker_id),
    asString(metadata.assigneeWorkerId),
    asString(metadata.assignee_worker_id),
    asString(taskMetadata.assigneeWorkerId),
    asString(taskMetadata.assignee_worker_id),
    currentState?.assigneeWorkerId ?? '',
  );
  if (!raw) return undefined;
  if (raw === FINGER_PROJECT_AGENT_ID) return undefined;
  return raw;
}

function resolveBlockedByRawFromDispatch(input: AgentDispatchRequest): unknown {
  const assignment: Record<string, unknown> = isObjectRecord(input.assignment) ? input.assignment : {};
  const taskRecord: Record<string, unknown> = isObjectRecord(input.task) ? input.task : {};
  const metadata: Record<string, unknown> = isObjectRecord(input.metadata) ? input.metadata : {};
  const taskMetadata: Record<string, unknown> = isObjectRecord(taskRecord.metadata) ? taskRecord.metadata : {};
  return (
    assignment.blockedBy
    ?? assignment.blocked_by
    ?? assignment.depends_on
    ?? assignment.dependsOn
    ?? taskRecord.blockedBy
    ?? taskRecord.blocked_by
    ?? taskRecord.depends_on
    ?? taskRecord.dependsOn
    ?? metadata.blockedBy
    ?? metadata.blocked_by
    ?? metadata.depends_on
    ?? metadata.dependsOn
    ?? taskMetadata.blockedBy
    ?? taskMetadata.blocked_by
    ?? taskMetadata.depends_on
    ?? taskMetadata.dependsOn
  );
}

function normalizeBlockedByFromDispatch(input: AgentDispatchRequest): string[] | undefined {
  return normalizeBlockedByForTaskState(resolveBlockedByRawFromDispatch(input));
}

function hasBlockedByMixedNoneAndDependencies(value: unknown): boolean {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]/)
      : [];
  if (!Array.isArray(list) || list.length === 0) return false;
  let hasNone = false;
  let hasDependency = false;
  for (const item of list) {
    const normalized = asTrimmedString(item).toLowerCase();
    if (!normalized) continue;
    if (normalized === BLOCKED_BY_NONE) {
      hasNone = true;
    } else {
      hasDependency = true;
    }
    if (hasNone && hasDependency) return true;
  }
  return false;
}

function resolveDispatchSourceTag(input: AgentDispatchRequest): string {
  const metadata = isObjectRecord(input.metadata) ? input.metadata : {};
  const taskRecord = isObjectRecord(input.task) ? input.task : {};
  const taskMetadata = isObjectRecord(taskRecord.metadata) ? taskRecord.metadata : {};
  return asTrimmedString(
    metadata.source
    ?? taskMetadata.source
    ?? '',
  ).toLowerCase();
}

function isTaskUpdateDispatch(input: AgentDispatchRequest): boolean {
  const metadata = isObjectRecord(input.metadata) ? input.metadata : {};
  const taskRecord = isObjectRecord(input.task) ? input.task : {};
  const taskMetadata = isObjectRecord(taskRecord.metadata) ? taskRecord.metadata : {};
  return metadata.projectTaskUpdate === true
    || metadata.taskUpdate === true
    || taskMetadata.projectTaskUpdate === true
    || taskMetadata.taskUpdate === true;
}

function validateBlockedByForProjectTaskCreation(params: {
  input: AgentDispatchRequest;
  sourceTaskState: ReturnType<typeof parseProjectTaskState>;
  identity: { taskId?: string; taskName?: string };
}): { ok: true; blockedBy: string[] } | { ok: false; error: string } {
  const { input, sourceTaskState, identity } = params;
  const sameTask = (
    !!sourceTaskState
    && (
      (!!identity.taskId && identity.taskId === sourceTaskState.taskId)
      || (!!identity.taskName && identity.taskName === sourceTaskState.taskName)
    )
  );
  if (isTaskUpdateDispatch(input) || sameTask) {
    const blockedBy = normalizeBlockedByFromDispatch(input) ?? sourceTaskState?.blockedBy ?? [BLOCKED_BY_NONE];
    return { ok: true, blockedBy };
  }

  const sourceTag = resolveDispatchSourceTag(input);
  if (DISPATCH_BLOCKED_BY_OPTIONAL_SOURCES.has(sourceTag)) {
    return { ok: true, blockedBy: normalizeBlockedByFromDispatch(input) ?? [BLOCKED_BY_NONE] };
  }

  const blockedBy = normalizeBlockedByFromDispatch(input);
  const blockedByRaw = resolveBlockedByRawFromDispatch(input);
  if (!blockedBy || blockedBy.length === 0) {
    return {
      ok: false,
      error: 'project task dispatch requires assignment.blocked_by (use ["none"] when no blockers)',
    };
  }
  if (hasBlockedByMixedNoneAndDependencies(blockedByRaw)) {
    return {
      ok: false,
      error: 'project task dispatch blocked_by cannot mix "none" with real task ids',
    };
  }
  return {
    ok: true,
    blockedBy: blockedBy.length === 0 ? [BLOCKED_BY_NONE] : blockedBy,
  };
}

function resolveBlockingDependencies(params: {
  deps: AgentRuntimeDeps;
  sessionIds: string[];
  blockedBy: string[];
}): string[] {
  if (params.blockedBy.length === 0 || (params.blockedBy.length === 1 && params.blockedBy[0] === BLOCKED_BY_NONE)) {
    return [];
  }
  const unresolved = new Set<string>();
  for (const sessionId of params.sessionIds) {
    const session = params.deps.sessionManager.getSession(sessionId);
    if (!session) continue;
    const registry = parseDelegatedProjectTaskRegistry(session.context?.projectTaskRegistry);
    const byTaskId = new Map<string, string>();
    for (const record of registry) {
      const taskId = asTrimmedString(record.taskId);
      if (!taskId) continue;
      byTaskId.set(taskId, asTrimmedString(record.status));
    }
    for (const blocker of params.blockedBy) {
      const blockerId = asTrimmedString(blocker);
      if (!blockerId || blockerId.toLowerCase() === BLOCKED_BY_NONE) continue;
      const status = asTrimmedString(byTaskId.get(blockerId)).toLowerCase();
      if (status !== 'closed') {
        unresolved.add(blockerId);
      }
    }
  }
  return Array.from(unresolved.values());
}

function allowDispatchWhileBusy(input: AgentDispatchRequest): boolean {
  const metadata = isObjectRecord(input.metadata) ? input.metadata : {};
  const taskRecord = isObjectRecord(input.task) ? input.task : {};
  const taskMetadata = isObjectRecord(taskRecord.metadata) ? taskRecord.metadata : {};
  const explicit =
    metadata.allowDispatchWhileBusy
    ?? metadata.allow_dispatch_while_busy
    ?? metadata.forceDispatch
    ?? metadata.force_dispatch
    ?? taskMetadata.allowDispatchWhileBusy
    ?? taskMetadata.allow_dispatch_while_busy
    ?? taskMetadata.forceDispatch
    ?? taskMetadata.force_dispatch;
  return explicit === true;
}

async function resolveBusyProjectAgentState(
  deps: AgentRuntimeDeps,
  input: AgentDispatchRequest,
): Promise<{
  busy: boolean;
  status?: string;
  dispatchId?: string;
  taskId?: string;
  summary?: string;
}> {
  if (input.sourceAgentId !== FINGER_SYSTEM_AGENT_ID || input.targetAgentId !== FINGER_PROJECT_AGENT_ID) {
    return { busy: false };
  }
  if (allowDispatchWhileBusy(input)) {
    return { busy: false };
  }
  try {
    const snapshot = await deps.agentRuntimeBlock.execute('runtime_view', {});
    const view = isObjectRecord(snapshot) ? snapshot : {};
    const agents = Array.isArray(view.agents) ? view.agents : [];
    const target = agents.find((agent) => (
      isObjectRecord(agent)
      && asTrimmedString(agent.id) === FINGER_PROJECT_AGENT_ID
    ));
    if (!isObjectRecord(target)) return { busy: false };
    const status = asTrimmedString(target.status).toLowerCase();
    const busy = BUSY_RUNTIME_STATUSES.has(status);
    if (!busy) {
      return { busy: false, ...(status ? { status } : {}) };
    }
    const lastEvent = isObjectRecord(target.lastEvent) ? target.lastEvent : {};
    const eventTaskId = asTrimmedString(lastEvent.taskId);
    const eventDispatchId = asTrimmedString(lastEvent.dispatchId);
    const eventSummary = asTrimmedString(lastEvent.summary);
    return {
      busy: true,
      ...(status ? { status } : {}),
      ...(eventDispatchId ? { dispatchId: eventDispatchId } : {}),
      ...(eventTaskId ? { taskId: eventTaskId } : {}),
      ...(eventSummary ? { summary: eventSummary } : {}),
    };
  } catch (error) {
    logger.module('dispatch').warn('Failed to inspect runtime busy state; continue dispatch without busy gating', {
      sourceAgentId: input.sourceAgentId,
      targetAgentId: input.targetAgentId,
      sessionId: asTrimmedString(input.sessionId) || undefined,
      error: error instanceof Error ? error.message : String(error),
    });
    return { busy: false };
  }
}

function resolveActiveProjectLifecycleState(
  deps: AgentRuntimeDeps,
  input: AgentDispatchRequest,
): {
  active: boolean;
  stage?: string;
  substage?: string;
  finishReason?: string;
  dispatchId?: string;
  turnId?: string;
} {
  if (input.sourceAgentId !== FINGER_SYSTEM_AGENT_ID || input.targetAgentId !== FINGER_PROJECT_AGENT_ID) {
    return { active: false };
  }
  if (allowDispatchWhileBusy(input)) return { active: false };
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (!sessionId) return { active: false };
  const lifecycle = getExecutionLifecycleState(deps.sessionManager, sessionId);
  if (!lifecycle) return { active: false };
  const finishReason = typeof lifecycle.finishReason === 'string'
    ? lifecycle.finishReason.trim().toLowerCase()
    : '';
  if (finishReason === 'stop') {
    return {
      active: false,
      stage: lifecycle.stage,
      ...(lifecycle.substage ? { substage: lifecycle.substage } : {}),
      ...(lifecycle.finishReason ? { finishReason: lifecycle.finishReason } : {}),
    };
  }
  if (!ACTIVE_PROJECT_LIFECYCLE_STAGES.has(lifecycle.stage)) {
    return {
      active: false,
      stage: lifecycle.stage,
      ...(lifecycle.substage ? { substage: lifecycle.substage } : {}),
      ...(lifecycle.finishReason ? { finishReason: lifecycle.finishReason } : {}),
    };
  }
  return {
    active: true,
    stage: lifecycle.stage,
    ...(lifecycle.substage ? { substage: lifecycle.substage } : {}),
    ...(lifecycle.finishReason ? { finishReason: lifecycle.finishReason } : {}),
    ...(lifecycle.dispatchId ? { dispatchId: lifecycle.dispatchId } : {}),
    ...(lifecycle.turnId ? { turnId: lifecycle.turnId } : {}),
  };
}

function resolveProjectTaskStateSessionIds(
  originalSessionId: string,
  normalizedSessionId?: string,
  ...extraSessionIds: Array<string | undefined>
): string[] {
  const values = [originalSessionId, normalizedSessionId ?? '', ...extraSessionIds]
    .map((item) => (item ?? '').trim())
    .filter((item) => item.length > 0);
  return Array.from(new Set(values));
}

function resolveSessionContextRouteSessionId(
  deps: AgentRuntimeDeps,
  sessionId: string,
): string {
  if (!sessionId) return '';
  const session = deps.sessionManager.getSession(sessionId);
  if (!session || !isObjectRecord(session.context)) return '';
  const context = session.context as Record<string, unknown>;
  return (
    asTrimmedString(context.statusRouteSessionId)
    || asTrimmedString(context.rootSessionId)
    || asTrimmedString(context.parentSessionId)
    || ''
  );
}

function resolveSourceProjectTaskState(
  deps: AgentRuntimeDeps,
  ...sessionIds: Array<string | undefined>
): ReturnType<typeof parseProjectTaskState> {
  const candidates = Array.from(new Set(
    sessionIds
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0),
  ));
  if (candidates.length === 0) return null;
  let newestActive: ReturnType<typeof parseProjectTaskState> = null;
  let newestActiveUpdatedAt = -1;
  let newestAny: ReturnType<typeof parseProjectTaskState> = null;
  let newestAnyUpdatedAt = -1;
  for (const sessionId of candidates) {
    const session = deps.sessionManager.getSession(sessionId);
    if (!session || !isObjectRecord(session.context)) continue;
    const context = session.context as Record<string, unknown>;
    const parsed = parseProjectTaskState(context.projectTaskState);
    if (!parsed) continue;
    const updatedAtMs = Date.parse(parsed.updatedAt);
    const normalizedUpdatedAt = Number.isFinite(updatedAtMs) ? updatedAtMs : -1;
    if (isProjectTaskStateActive(parsed) && normalizedUpdatedAt >= newestActiveUpdatedAt) {
      newestActive = parsed;
      newestActiveUpdatedAt = normalizedUpdatedAt;
    }
    if (normalizedUpdatedAt >= newestAnyUpdatedAt) {
      newestAny = parsed;
      newestAnyUpdatedAt = normalizedUpdatedAt;
    }
  }
  return newestActive ?? newestAny;
}

function resolveCanonicalSystemSessionId(deps: AgentRuntimeDeps): string {
  const sessionManager = deps.sessionManager as {
    getOrCreateSystemSession?: () => { id?: string } | null;
  };
  if (typeof sessionManager.getOrCreateSystemSession !== 'function') return '';
  try {
    const session = sessionManager.getOrCreateSystemSession();
    const sessionId = typeof session?.id === 'string' ? session.id.trim() : '';
    return sessionId;
  } catch (error) {
    logger.module('dispatch').warn('Failed to resolve canonical system session id', {
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}

function resolveDispatchProjectPathHint(
  input: AgentDispatchRequest,
  fallbackProjectPath?: string,
): string {
  const metadata = isObjectRecord(input.metadata) ? input.metadata : {};
  const taskRecord = isObjectRecord(input.task) ? input.task : {};
  const taskMetadata = isObjectRecord(taskRecord.metadata) ? taskRecord.metadata : {};
  const raw = firstNonEmptyString(
    input.projectPath,
    asString(metadata.projectPath),
    asString(metadata.project_path),
    asString(metadata.cwd),
    asString(taskRecord.projectPath),
    asString(taskRecord.project_path),
    asString(taskRecord.cwd),
    asString(taskMetadata.projectPath),
    asString(taskMetadata.project_path),
    asString(taskMetadata.cwd),
    fallbackProjectPath,
  ) ?? '';
  if (!raw) return '';
  return normalizeProjectPathHint(raw);
}

function isSameProjectTaskIdentity(
  activeState: ReturnType<typeof parseProjectTaskState>,
  identity: { taskId?: string; taskName?: string },
): boolean {
  if (!activeState) return false;
  if (identity.taskId && activeState.taskId && identity.taskId === activeState.taskId) return true;
  if (identity.taskName && activeState.taskName && identity.taskName === activeState.taskName) return true;
  return false;
}

function isProjectTaskUpdateDispatch(input: AgentDispatchRequest): boolean {
  const metadata = isObjectRecord(input.metadata) ? input.metadata : {};
  const taskRecord = isObjectRecord(input.task) ? input.task : {};
  const taskMetadata = isObjectRecord(taskRecord.metadata) ? taskRecord.metadata : {};
  return metadata.projectTaskUpdate === true
    || metadata.project_task_update === true
    || metadata.source === 'project-task-update'
    || taskMetadata.taskUpdate === true
    || taskMetadata.task_update === true;
}

function resolveRequestedTaskSessionId(
  callerSessionId: string,
  normalizedSessionId: string,
  routeSessionId: string,
): string {
  return firstNonEmptyString(normalizedSessionId, routeSessionId, callerSessionId) ?? '';
}

function validateProjectTaskBindingGuard(params: {
  input: AgentDispatchRequest;
  sourceTaskState: ReturnType<typeof parseProjectTaskState>;
  identity: { taskId?: string; taskName?: string };
  requestedSessionId: string;
}): { ok: true; boundSessionId: string; revision: number } | { ok: false; error: string } {
  const { input, sourceTaskState, identity, requestedSessionId } = params;
  const persistedRevision = sourceTaskState?.revision;
  const hasPersistedRevision = typeof persistedRevision === 'number' && Number.isFinite(persistedRevision);
  const currentRevision = hasPersistedRevision
    ? Math.max(1, Math.floor(persistedRevision))
    : 0;
  if (!(input.sourceAgentId === FINGER_SYSTEM_AGENT_ID && input.targetAgentId === FINGER_PROJECT_AGENT_ID)) {
    return { ok: true, boundSessionId: requestedSessionId, revision: currentRevision || 1 };
  }

  if (!isProjectTaskStateActive(sourceTaskState)) {
    return {
      ok: true,
      boundSessionId: requestedSessionId,
      revision: currentRevision > 0 ? currentRevision + 1 : 1,
    };
  }

  const activeTaskId = asTrimmedString(sourceTaskState?.taskId);
  const activeTaskName = asTrimmedString(sourceTaskState?.taskName);
  const activeBoundSessionId = asTrimmedString(sourceTaskState?.boundSessionId);
  const incomingTaskId = asTrimmedString(identity.taskId);
  const incomingTaskName = asTrimmedString(identity.taskName);
  const incomingSessionId = asTrimmedString(requestedSessionId);
  const updateDispatch = isProjectTaskUpdateDispatch(input);
  const asyncProjectDispatch = (
    input.sourceAgentId === FINGER_SYSTEM_AGENT_ID
    && input.targetAgentId === FINGER_PROJECT_AGENT_ID
    && input.blocking !== true
    && input.queueOnBusy !== false
  );

  if (asyncProjectDispatch) {
    const nextRevision = (currentRevision > 0 ? currentRevision : 1) + 1;
    return {
      ok: true,
      boundSessionId: activeBoundSessionId || incomingSessionId,
      revision: nextRevision,
    };
  }

  if (activeTaskId && incomingTaskId && activeTaskId !== incomingTaskId) {
    return {
      ok: false,
      error: `project task binding mismatch: active taskId=${activeTaskId}, incoming taskId=${incomingTaskId}; use project.task.update for same task only`,
    };
  }
  if (!activeTaskId && activeTaskName && incomingTaskName && activeTaskName !== incomingTaskName) {
    return {
      ok: false,
      error: `project task binding mismatch: active taskName=${activeTaskName}, incoming taskName=${incomingTaskName}; use project.task.update for same task only`,
    };
  }
  if (activeBoundSessionId && incomingSessionId && activeBoundSessionId !== incomingSessionId) {
    return {
      ok: false,
      error: `project task binding mismatch: active boundSessionId=${activeBoundSessionId}, incoming sessionId=${incomingSessionId}; resume bound session instead of switching`,
    };
  }
  if ((activeTaskId || activeTaskName) && !incomingTaskId && !incomingTaskName && !updateDispatch) {
    return {
      ok: false,
      error: 'project task binding mismatch: active task exists but incoming dispatch has no task identity',
    };
  }

  const nextRevisionBase = currentRevision > 0 ? currentRevision : 1;
  const nextRevision = updateDispatch ? nextRevisionBase + 1 : nextRevisionBase;
  return {
    ok: true,
    boundSessionId: activeBoundSessionId || incomingSessionId,
    revision: nextRevision,
  };
}

function appendProjectTaskHint(
  summary: string,
  params: {
    taskId?: string;
    taskName?: string;
    status?: string;
    sourceSessionId?: string;
    dispatchId?: string;
  },
): string {
  const hint = [
    `project_task_state=${params.status ?? 'in_progress'}`,
    params.taskId ? `taskId=${params.taskId}` : '',
    params.taskName ? `taskName=${params.taskName}` : '',
    params.dispatchId ? `dispatchId=${params.dispatchId}` : '',
    params.sourceSessionId ? `sourceSession=${params.sourceSessionId}` : '',
  ].filter(Boolean).join(' ');
  if (!hint) return summary;
  return `${summary}\n${hint}\nRule: task already delegated/in-progress -> use project.task.status / project.task.update, do NOT redispatch.`;
}

function persistProjectTaskState(
  deps: AgentRuntimeDeps,
  sessionIds: string[],
  patch: {
    active?: boolean;
    status?: 'create' | 'dispatched' | 'accepted' | 'in_progress' | 'claiming_finished' | 'reviewed' | 'reported' | 'closed' | 'blocked' | 'failed' | 'cancelled';
    assignerName?: string;
    assigneeWorkerId?: string;
    assigneeWorkerName?: string;
    deliveryWorkerId?: string;
    deliveryWorkerName?: string;
    reviewerId?: string;
    reviewerName?: string;
    reassignReason?: string;
    taskId?: string;
    taskName?: string;
    dispatchId?: string;
    boundSessionId?: string;
    revision?: number;
    summary?: string;
    note?: string;
    blockedBy?: string[];
    sourceAgentId?: string;
    targetAgentId?: string;
  },
): void {
  const applyResult = applyProjectStatusGatewayPatch({
    sessionManager: deps.sessionManager,
    sessionIds,
    patch: {
      ...patch,
      sourceAgentId: patch.sourceAgentId ?? FINGER_SYSTEM_AGENT_ID,
      targetAgentId: patch.targetAgentId ?? FINGER_PROJECT_AGENT_ID,
    },
    source: 'dispatch.persistProjectTaskState',
  });
  for (const item of applyResult.errors) {
    logger.module('dispatch').warn('Failed to persist project task state patch', {
      sessionId: item.sessionId,
      taskId: patch.taskId,
      taskName: patch.taskName,
      status: patch.status,
      note: patch.note,
      error: item.error,
    });
  }
}

export async function dispatchTaskToAgent(deps: AgentRuntimeDeps, input: AgentDispatchRequest): Promise<{
  ok: boolean;
  dispatchId: string;
  status: 'queued' | 'completed' | 'failed';
  result?: DispatchSummaryResult;
  error?: string;
  queuePosition?: number;
}> {
  const targetNormalization = normalizeDispatchTargetAgentId(asTrimmedString(input.targetAgentId));
  if (targetNormalization.invalidReason) {
    const failedSessionId = firstNonEmptyString(
      asTrimmedString(input.sessionId),
      asTrimmedString(deps.runtime.getCurrentSession()?.id),
      asTrimmedString(deps.sessionManager.getCurrentSession()?.id),
    );
    if (failedSessionId) {
      applyExecutionLifecycleTransition(deps.sessionManager, failedSessionId, {
        stage: 'failed',
        substage: 'dispatch_target_invalid',
        updatedBy: 'dispatch',
        targetAgentId: asTrimmedString(input.targetAgentId),
        lastError: targetNormalization.invalidReason,
      });
    }
    return {
      ok: false,
      dispatchId: 'dispatch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      status: 'failed',
      error: targetNormalization.invalidReason,
    };
  }
  if (
    targetNormalization.targetAgentId
    && targetNormalization.targetAgentId !== asTrimmedString(input.targetAgentId)
  ) {
    const nextMetadata = isObjectRecord(input.metadata) ? { ...input.metadata } : {};
    nextMetadata.normalizedDispatchTarget = {
      from: targetNormalization.normalizedFrom ?? asTrimmedString(input.targetAgentId),
      to: targetNormalization.targetAgentId,
    };
    input = {
      ...input,
      targetAgentId: targetNormalization.targetAgentId,
      metadata: nextMetadata,
    };
    logger.module('dispatch').info('Normalized dispatch target alias', {
      from: targetNormalization.normalizedFrom ?? asTrimmedString(input.targetAgentId),
      to: targetNormalization.targetAgentId,
      sourceAgentId: asTrimmedString(input.sourceAgentId),
      sessionId: asTrimmedString(input.sessionId) || undefined,
    });
  }

  const originalSessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  const callerSessionId = firstNonEmptyString(
    originalSessionId,
    deps.runtime.getCurrentSession()?.id,
    deps.sessionManager.getCurrentSession()?.id,
  ) ?? '';
  const fallbackDispatchId = 'dispatch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const sourceAgentId = firstNonEmptyString(
    asTrimmedString(input.sourceAgentId),
    asTrimmedString(deps.primaryOrchestratorAgentId),
  ) ?? '';
  const targetAgentId = asTrimmedString(input.targetAgentId);
  if (sourceAgentId.length > 0 && targetAgentId.length > 0 && sourceAgentId === targetAgentId) {
    const error = `self-dispatch forbidden: source and target are both ${targetAgentId}; recovery: execute task locally in current agent or dispatch to a different target_agent_id`;
    logger.module('dispatch').warn('Rejected self-dispatch request', {
      sourceAgentId,
      targetAgentId,
      sessionId: callerSessionId || undefined,
    });
    if (callerSessionId) {
      applyExecutionLifecycleTransition(deps.sessionManager, callerSessionId, {
        stage: 'failed',
        substage: 'dispatch_self_forbidden',
        updatedBy: 'dispatch',
        targetAgentId,
        lastError: error,
      });
    }
    return {
      ok: false,
      dispatchId: fallbackDispatchId,
      status: 'failed',
      error,
    };
  }

  if (sourceAgentId === FINGER_SYSTEM_AGENT_ID && targetAgentId === FINGER_PROJECT_AGENT_ID) {
    const workerSelection = await resolveSystemProjectDispatchWorker(deps, input);
    input = workerSelection.input;
    if (workerSelection.workerId) {
      logger.module('dispatch').info('Resolved project worker for system dispatch', {
        sourceAgentId,
        targetAgentId,
        sessionId: callerSessionId || undefined,
        workerId: workerSelection.workerId,
        workerName: workerSelection.workerName,
        reason: workerSelection.reason,
      });
    }
  }

  let normalizedInput: AgentDispatchRequest;
  try {
    const sessionSelectedInput = resolveDispatchSessionSelection(deps, input);
    const boundInput = bindDispatchSessionToRuntime(deps, sessionSelectedInput);
    normalizedInput = withDispatchWorkspaceDefaults(deps, boundInput);
    if (
      normalizedInput.sourceAgentId === FINGER_SYSTEM_AGENT_ID
      && isProjectScopedDispatchTargetId(normalizedInput.targetAgentId)
    ) {
      const sessionId = typeof normalizedInput.sessionId === 'string' ? normalizedInput.sessionId.trim() : '';
      const boundSession = sessionId ? deps.sessionManager.getSession(sessionId) : null;
      const boundSessionSystemOwned = sessionId ? isSystemOwnedSession(deps, sessionId) : false;
      const explicitProjectPathHint = resolveDispatchProjectPathHint(normalizedInput);
      const projectPathHint = explicitProjectPathHint || resolveDispatchProjectPathHint(normalizedInput, boundSession?.projectPath);
      if (projectPathHint) {
        const metadata = isObjectRecord(normalizedInput.metadata) ? normalizedInput.metadata : {};
        const taskRecord = isObjectRecord(normalizedInput.task) ? normalizedInput.task : {};
        const taskMetadata = isObjectRecord(taskRecord.metadata) ? taskRecord.metadata : {};
        const autoRegisterProject = parseBooleanFlag(
          metadata.autoRegisterProject
          ?? metadata.auto_register_project
          ?? metadata.confirmRegisterProject
          ?? metadata.confirm_register_project
          ?? metadata.registerProjectConfirmed
          ?? metadata.register_project_confirmed
          ?? taskMetadata.autoRegisterProject
          ?? taskMetadata.auto_register_project
          ?? taskMetadata.confirmRegisterProject
          ?? taskMetadata.confirm_register_project,
        ) === true;

        let existingAgent = null as Awaited<ReturnType<typeof listAgents>>[number] | null;
        if (!boundSessionSystemOwned && explicitProjectPathHint) {
          const registeredAgents = await listAgents();
          existingAgent = registeredAgents.find((item) => {
            const normalizedPath = normalizeProjectPathHint(typeof item.projectPath === 'string' ? item.projectPath : '');
            return normalizedPath === projectPathHint;
          }) ?? null;
        }

        if (!boundSessionSystemOwned && explicitProjectPathHint && !existingAgent && !autoRegisterProject) {
          const error = [
            `project path is not registered: ${projectPathHint}`,
            'ACTION REQUIRED: ask user "该项目尚未注册，是否自动注册并继续派发？"',
            'If user confirms, retry same dispatch with metadata.autoRegisterProject=true.',
          ].join(' ');
          logger.module('dispatch').warn('Rejected dispatch: project path not registered (confirmation required)', {
            sourceAgentId: normalizedInput.sourceAgentId,
            targetAgentId: normalizedInput.targetAgentId,
            sessionId: sessionId || undefined,
            projectPathHint,
          });
          const failedSessionId = firstNonEmptyString(
            sessionId,
            callerSessionId,
          );
          if (failedSessionId) {
            applyExecutionLifecycleTransition(deps.sessionManager, failedSessionId, {
              stage: shouldGuaranteeDispatchToTasklist(normalizedInput) ? 'dispatching' : 'failed',
              substage: shouldGuaranteeDispatchToTasklist(normalizedInput)
                ? 'dispatch_project_registration_confirmation_queued'
                : 'dispatch_project_registration_confirmation_required',
              updatedBy: 'dispatch',
              targetAgentId: normalizedInput.targetAgentId,
              lastError: shouldGuaranteeDispatchToTasklist(normalizedInput) ? null : error,
              detail: shouldGuaranteeDispatchToTasklist(normalizedInput) ? error : undefined,
              recoveryAction: shouldGuaranteeDispatchToTasklist(normalizedInput) ? 'ask_user_confirm' : undefined,
              delivery: shouldGuaranteeDispatchToTasklist(normalizedInput) ? 'mailbox' : undefined,
            });
          }
          if (shouldGuaranteeDispatchToTasklist(normalizedInput)) {
            return await buildGuaranteedQueuedDispatchResultWithMailbox(deps, normalizedInput, {
              dispatchId: fallbackDispatchId,
              reason: `project registration confirmation required; queued until confirmed: ${projectPathHint}`,
              originalStatus: 'failed',
            });
          }
          return {
            ok: false,
            dispatchId: fallbackDispatchId,
            status: 'failed',
            error,
          };
        }

        let resolvedAgent = existingAgent;
        try {
          if (!resolvedAgent && explicitProjectPathHint) {
            resolvedAgent = await setMonitorStatus(projectPathHint, true);
            logger.module('dispatch').info('Auto-registered project path before dispatch (user confirmed)', {
              sourceAgentId: normalizedInput.sourceAgentId,
              targetAgentId: normalizedInput.targetAgentId,
              sessionId: sessionId || undefined,
              projectPathHint,
              projectId: resolvedAgent.projectId,
              projectAgentId: resolvedAgent.agentId,
            });
          }
          if (resolvedAgent) {
            const nextMetadata = { ...(isObjectRecord(normalizedInput.metadata) ? normalizedInput.metadata : {}) };
            nextMetadata.projectId = resolvedAgent.projectId;
            nextMetadata.projectPath = resolvedAgent.projectPath;
            nextMetadata.projectAgentId = resolvedAgent.agentId;
            nextMetadata.projectMonitored = resolvedAgent.monitored === true;
            if (!existingAgent && autoRegisterProject) {
              nextMetadata.projectAutoRegistered = true;
            }
            normalizedInput = {
              ...normalizedInput,
              projectPath: resolvedAgent.projectPath,
              metadata: nextMetadata,
            };
          }
        } catch (registerError) {
          const error = registerError instanceof Error ? registerError.message : String(registerError);
          logger.module('dispatch').warn('Project registration resolution failed for dispatch', {
            targetAgentId: normalizedInput.targetAgentId,
            sessionId,
            projectPathHint,
            error,
          });
          const failedSessionId = firstNonEmptyString(
            sessionId,
            callerSessionId,
          );
          if (failedSessionId) {
            applyExecutionLifecycleTransition(deps.sessionManager, failedSessionId, {
              stage: shouldGuaranteeDispatchToTasklist(normalizedInput) ? 'dispatching' : 'failed',
              substage: shouldGuaranteeDispatchToTasklist(normalizedInput)
                ? 'dispatch_project_registration_resolve_failed_queued'
                : 'dispatch_project_registration_resolve_failed',
              updatedBy: 'dispatch',
              targetAgentId: normalizedInput.targetAgentId,
              lastError: shouldGuaranteeDispatchToTasklist(normalizedInput) ? null : error,
              detail: shouldGuaranteeDispatchToTasklist(normalizedInput) ? error : undefined,
              recoveryAction: shouldGuaranteeDispatchToTasklist(normalizedInput) ? 'mailbox' : undefined,
              delivery: shouldGuaranteeDispatchToTasklist(normalizedInput) ? 'mailbox' : undefined,
            });
          }
          if (shouldGuaranteeDispatchToTasklist(normalizedInput)) {
            return await buildGuaranteedQueuedDispatchResultWithMailbox(deps, normalizedInput, {
              dispatchId: fallbackDispatchId,
              reason: `project registration resolve failed normalized to queued tasklist: ${error}`,
              originalStatus: 'failed',
            });
          }
          return {
            ok: false,
            dispatchId: fallbackDispatchId,
            status: 'failed',
            error: `project registration resolve failed: ${error}`,
          };
        }
      }
    }
    if (
      normalizedInput.sourceAgentId === FINGER_SYSTEM_AGENT_ID
      && normalizedInput.targetAgentId === FINGER_PROJECT_AGENT_ID
    ) {
      const assignment = isObjectRecord(normalizedInput.assignment) ? { ...normalizedInput.assignment } : {};
      const hasTaskId = typeof assignment.taskId === 'string' && assignment.taskId.trim().length > 0;
      if (!hasTaskId) {
        assignment.taskId = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      }
      if (typeof assignment.assignerAgentId !== 'string' || assignment.assignerAgentId.trim().length === 0) {
        assignment.assignerAgentId = FINGER_SYSTEM_AGENT_ID;
      }
      if (typeof assignment.assigneeAgentId !== 'string' || assignment.assigneeAgentId.trim().length === 0) {
        assignment.assigneeAgentId = FINGER_PROJECT_AGENT_ID;
      }
      if (typeof assignment.attempt !== 'number' || !Number.isFinite(assignment.attempt) || assignment.attempt < 1) {
        assignment.attempt = 1;
      }
      if (typeof assignment.phase !== 'string' || assignment.phase.trim().length === 0) {
        assignment.phase = 'assigned';
      }
      const blockedBy = normalizeBlockedByFromDispatch({
        ...normalizedInput,
        assignment,
      });
      const hasExplicitBlockedByInAssignment = (
        Array.isArray((assignment as Record<string, unknown>).blockedBy)
        || typeof (assignment as Record<string, unknown>).blockedBy === 'string'
        || Array.isArray((assignment as Record<string, unknown>).blocked_by)
        || typeof (assignment as Record<string, unknown>).blocked_by === 'string'
      );
      if (!hasExplicitBlockedByInAssignment && blockedBy && blockedBy.length > 0) {
        assignment.blockedBy = blockedBy;
      }
      normalizedInput = {
        ...normalizedInput,
        assignment,
      };
    }
    if (normalizedInput.targetAgentId === FINGER_SYSTEM_AGENT_ID) {
      const getSystemSession = (deps.sessionManager as {
        getOrCreateSystemSession?: () => { id?: string };
      }).getOrCreateSystemSession;
      if (typeof getSystemSession === 'function') {
        const systemSession = getSystemSession.call(deps.sessionManager);
        const forcedSystemSessionId = typeof systemSession?.id === 'string' ? systemSession.id.trim() : '';
        const currentDispatchSessionId = typeof normalizedInput.sessionId === 'string'
          ? normalizedInput.sessionId.trim()
          : '';
        if (forcedSystemSessionId.length > 0 && forcedSystemSessionId !== currentDispatchSessionId) {
          const metadata = isObjectRecord(normalizedInput.metadata) ? { ...normalizedInput.metadata } : {};
          metadata.dispatchForcedSystemSession = true;
          metadata.dispatchOriginalSessionId = currentDispatchSessionId || undefined;
          normalizedInput = {
            ...normalizedInput,
            sessionId: forcedSystemSessionId,
            metadata,
          };
        }
      }
    }
    if (originalSessionId
      && typeof normalizedInput.sessionId === 'string'
      && normalizedInput.sessionId.trim().length > 0
      && originalSessionId !== normalizedInput.sessionId.trim()) {
      const metadata = isObjectRecord(normalizedInput.metadata) ? { ...normalizedInput.metadata } : {};
      metadata.dispatchParentSessionId = originalSessionId;
      metadata.dispatchChildSessionId = normalizedInput.sessionId.trim();
      normalizedInput = {
        ...normalizedInput,
        metadata,
      };
    }
    if (
      normalizedInput.sourceAgentId === FINGER_SYSTEM_AGENT_ID
      && normalizedInput.targetAgentId === FINGER_PROJECT_AGENT_ID
    ) {
      const metadata = isObjectRecord(normalizedInput.metadata) ? { ...normalizedInput.metadata } : {};
      metadata.dispatchMode = 'system_async_project';
      metadata.dispatchNonBlockingEnforced = true;
      normalizedInput = {
        ...normalizedInput,
        blocking: false,
        queueOnBusy: true,
        maxQueueWaitMs: 0,
        metadata,
      };
    }
    const resolvedSessionId = typeof normalizedInput.sessionId === 'string'
      ? normalizedInput.sessionId.trim()
      : '';
    if (!resolvedSessionId) {
      const error = 'dispatch requires an existing session binding (auto session create/switch disabled)';
      const failedSessionId = firstNonEmptyString(
        callerSessionId,
        deps.runtime.getCurrentSession()?.id,
        deps.sessionManager.getCurrentSession()?.id,
      );
      logger.module('dispatch').warn('Rejected dispatch: sessionId missing after strict selection', {
        sourceAgentId: normalizedInput.sourceAgentId,
        targetAgentId: normalizedInput.targetAgentId,
        strategy: normalizedInput.sessionStrategy,
        projectPath: resolveDispatchProjectPathHint(normalizedInput) || undefined,
      });
      if (failedSessionId) {
        applyExecutionLifecycleTransition(deps.sessionManager, failedSessionId, {
          stage: shouldGuaranteeDispatchToTasklist(normalizedInput) ? 'dispatching' : 'failed',
          substage: shouldGuaranteeDispatchToTasklist(normalizedInput)
            ? 'dispatch_missing_session_binding_queued'
            : 'dispatch_missing_session_binding',
          updatedBy: 'dispatch',
          targetAgentId: normalizedInput.targetAgentId,
          lastError: shouldGuaranteeDispatchToTasklist(normalizedInput) ? null : error,
          detail: shouldGuaranteeDispatchToTasklist(normalizedInput) ? error : undefined,
          recoveryAction: shouldGuaranteeDispatchToTasklist(normalizedInput) ? 'mailbox' : undefined,
          delivery: shouldGuaranteeDispatchToTasklist(normalizedInput) ? 'mailbox' : undefined,
        });
      }
      if (shouldGuaranteeDispatchToTasklist(normalizedInput)) {
        return await buildGuaranteedQueuedDispatchResultWithMailbox(deps, normalizedInput, {
          dispatchId: fallbackDispatchId,
          reason: `missing session binding normalized to queued tasklist: ${error}`,
          originalStatus: 'failed',
        });
      }
      return {
        ok: false,
        dispatchId: fallbackDispatchId,
        status: 'failed',
        error,
      };
    }
    const resolvedSession = deps.sessionManager.getSession(resolvedSessionId);
    if (!resolvedSession) {
      const error = `dispatch session not found: ${resolvedSessionId}`;
      const failedSessionId = firstNonEmptyString(
        callerSessionId,
        deps.runtime.getCurrentSession()?.id,
        deps.sessionManager.getCurrentSession()?.id,
      );
      logger.module('dispatch').warn('Rejected dispatch: resolved session missing', {
        sourceAgentId: normalizedInput.sourceAgentId,
        targetAgentId: normalizedInput.targetAgentId,
        sessionId: resolvedSessionId,
      });
      if (failedSessionId) {
        applyExecutionLifecycleTransition(deps.sessionManager, failedSessionId, {
          stage: shouldGuaranteeDispatchToTasklist(normalizedInput) ? 'dispatching' : 'failed',
          substage: shouldGuaranteeDispatchToTasklist(normalizedInput)
            ? 'dispatch_missing_session_record_queued'
            : 'dispatch_missing_session_record',
          updatedBy: 'dispatch',
          targetAgentId: normalizedInput.targetAgentId,
          lastError: shouldGuaranteeDispatchToTasklist(normalizedInput) ? null : error,
          detail: shouldGuaranteeDispatchToTasklist(normalizedInput) ? error : undefined,
          recoveryAction: shouldGuaranteeDispatchToTasklist(normalizedInput) ? 'mailbox' : undefined,
          delivery: shouldGuaranteeDispatchToTasklist(normalizedInput) ? 'mailbox' : undefined,
        });
      }
      if (shouldGuaranteeDispatchToTasklist(normalizedInput)) {
        return await buildGuaranteedQueuedDispatchResultWithMailbox(deps, normalizedInput, {
          dispatchId: fallbackDispatchId,
          reason: `missing session record normalized to queued tasklist: ${error}`,
          originalStatus: 'failed',
        });
      }
      return {
        ok: false,
        dispatchId: fallbackDispatchId,
        status: 'failed',
        error,
      };
    }
    if (resolvedSessionId !== normalizedInput.sessionId) {
      normalizedInput = {
        ...normalizedInput,
        sessionId: resolvedSessionId,
      };
    }
    let scopeValidation = validateDispatchSessionScope(deps, normalizedInput);
    if (!scopeValidation.ok && isProjectScopedDispatchTargetId(asTrimmedString(normalizedInput.targetAgentId))) {
      const repairedInput = resolveDispatchSessionSelection(deps, {
        ...normalizedInput,
        sessionId: undefined,
      });
      const repairedSessionId = asTrimmedString(repairedInput.sessionId);
      if (repairedSessionId) {
        normalizedInput = {
          ...repairedInput,
          metadata: {
            ...(isObjectRecord(repairedInput.metadata) ? repairedInput.metadata : {}),
            dispatchSessionScopeRepaired: true,
          },
        };
        scopeValidation = validateDispatchSessionScope(deps, normalizedInput);
        if (scopeValidation.ok) {
          logger.module('dispatch').warn('Auto-repaired dispatch session/project scope mismatch before dispatch', {
            sourceAgentId: normalizedInput.sourceAgentId,
            targetAgentId: normalizedInput.targetAgentId,
            repairedSessionId,
            projectPath: resolveDispatchProjectPathHint(normalizedInput) || undefined,
          });
        }
      }
    }
    if (!scopeValidation.ok) {
      const guaranteeTasklist = shouldGuaranteeDispatchToTasklist(normalizedInput);
      const failedSessionId = firstNonEmptyString(
        asTrimmedString(normalizedInput.sessionId),
        callerSessionId,
      );
      logger.module('dispatch').warn(
        guaranteeTasklist
          ? 'Dispatch session/project scope mismatch detected; normalized to queued tasklist'
          : 'Rejected dispatch due to session/project scope mismatch',
        {
        sourceAgentId: normalizedInput.sourceAgentId,
        targetAgentId: normalizedInput.targetAgentId,
        sessionId: asTrimmedString(normalizedInput.sessionId) || undefined,
        projectPath: resolveDispatchProjectPathHint(normalizedInput) || undefined,
        error: scopeValidation.error,
      });
      if (failedSessionId) {
        applyExecutionLifecycleTransition(deps.sessionManager, failedSessionId, {
          stage: guaranteeTasklist ? 'dispatching' : 'failed',
          substage: guaranteeTasklist
            ? 'dispatch_session_scope_mismatch_queued'
            : 'dispatch_session_scope_mismatch',
          updatedBy: 'dispatch',
          targetAgentId: normalizedInput.targetAgentId,
          lastError: guaranteeTasklist ? null : scopeValidation.error,
          detail: guaranteeTasklist ? scopeValidation.error : undefined,
          recoveryAction: guaranteeTasklist ? 'mailbox' : undefined,
          delivery: guaranteeTasklist ? 'mailbox' : undefined,
        });
      }
      if (guaranteeTasklist) {
        return await buildGuaranteedQueuedDispatchResultWithMailbox(deps, normalizedInput, {
          dispatchId: fallbackDispatchId,
          reason: `session scope mismatch normalized to queued tasklist: ${scopeValidation.error}`,
          originalStatus: 'failed',
        });
      }
      return {
        ok: false,
        dispatchId: fallbackDispatchId,
        status: 'failed',
        error: scopeValidation.error,
      };
    }
    if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
      deps.runtime.bindAgentSession(normalizedInput.targetAgentId, normalizedInput.sessionId);
    }
    const sessionIdForLedger = typeof normalizedInput.sessionId === 'string' ? normalizedInput.sessionId.trim() : '';
    if (sessionIdForLedger) {
      const transientPolicy = shouldUseTransientLedgerForDispatch(normalizedInput);
      if (transientPolicy.enabled) {
        const transientLedgerMode = `transient-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        deps.sessionManager.setTransientLedgerMode(sessionIdForLedger, transientLedgerMode, {
          source: transientPolicy.source,
          autoDeleteOnStop: true,
        });
        const metadata = isObjectRecord(normalizedInput.metadata) ? { ...normalizedInput.metadata } : {};
        metadata.ledgerMode = transientLedgerMode;
        metadata.transientLedger = true;
        metadata.transientLedgerMode = transientLedgerMode;
        normalizedInput = {
          ...normalizedInput,
          metadata,
        };
      } else {
        const dispatchMetadata = isObjectRecord(normalizedInput.metadata) ? normalizedInput.metadata : {};
        const isUserInbound = dispatchMetadata.role === 'user';
        if (isUserInbound) {
          deps.sessionManager.clearTransientLedgerMode(sessionIdForLedger);
        }
      }
    }
    normalizedInput = applyDispatchAutonomyDefaults(normalizedInput);
    applySessionProgressDeliveryFromDispatch(deps, normalizedInput);
    if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
      const sessionForSnapshot = deps.sessionManager.getSession(normalizedInput.sessionId.trim());
      const sessionContext = (sessionForSnapshot?.context && typeof sessionForSnapshot.context === 'object')
        ? (sessionForSnapshot.context as Record<string, unknown>)
        : {};
      const metadata = isObjectRecord(normalizedInput.metadata) ? { ...normalizedInput.metadata } : {};
      const taskRouterPath = (
        typeof sessionForSnapshot?.projectPath === 'string' && sessionForSnapshot.projectPath.trim().length > 0
          ? `${sessionForSnapshot.projectPath.replace(/\/+$/, '')}/TASK.md`
          : undefined
      );
      metadata.sessionContextSnapshot = {
        executionLifecycle: sessionContext.executionLifecycle,
        projectTaskState: sessionContext.projectTaskState,
        projectTaskRegistry: sessionContext.projectTaskRegistry,
        systemTaskState: sessionContext.systemTaskState,
        ...(taskRouterPath ? { taskRouterPath } : {}),
      };
      if (taskRouterPath) metadata.taskRouterPath = taskRouterPath;
      normalizedInput = {
        ...normalizedInput,
        metadata,
      };
    }
  } catch (preError) {
    const message = preError instanceof Error ? preError.message : String(preError);
    logger.module('dispatch').error('Pre-dispatch setup failed', preError instanceof Error ? preError : undefined, {
      targetAgentId: input.targetAgentId,
      sessionId: originalSessionId,
    });
    if (originalSessionId) {
      applyExecutionLifecycleTransition(deps.sessionManager, originalSessionId, {
        stage: 'failed',
        substage: 'dispatch_prepare_failed',
        updatedBy: 'dispatch',
        targetAgentId: input.targetAgentId,
        lastError: message,
      });
    }
    return { ok: false, dispatchId: fallbackDispatchId, status: 'failed', error: message };
  }

  const projectTaskIdentity = resolveDispatchTaskIdentity(normalizedInput);
  const forceAsyncSystemProjectDispatch = (
    normalizedInput.sourceAgentId === FINGER_SYSTEM_AGENT_ID
    && normalizedInput.targetAgentId === FINGER_PROJECT_AGENT_ID
  );
  const normalizedSessionId = typeof normalizedInput.sessionId === 'string' ? normalizedInput.sessionId.trim() : '';
  const routeSessionId = resolveSessionContextRouteSessionId(deps, normalizedSessionId);
  const canonicalSystemSessionId = resolveCanonicalSystemSessionId(deps);
  const sourceTaskState = resolveSourceProjectTaskState(
    deps,
    callerSessionId,
    normalizedSessionId,
    routeSessionId,
    canonicalSystemSessionId,
  );
  const assigneeWorkerId = resolveAssigneeWorkerIdFromDispatch(normalizedInput, sourceTaskState);
  const assignerName = resolveAgentDisplayName(normalizedInput.sourceAgentId);
  const assigneeWorkerName = assigneeWorkerId
    ? resolveAgentDisplayName(assigneeWorkerId)
    : resolveAgentDisplayName(normalizedInput.targetAgentId);
  const requestedTaskSessionId = resolveRequestedTaskSessionId(callerSessionId, normalizedSessionId, routeSessionId);
  const bindingGuard = validateProjectTaskBindingGuard({
    input: normalizedInput,
    sourceTaskState,
    identity: projectTaskIdentity,
    requestedSessionId: requestedTaskSessionId,
  });
  if (!bindingGuard.ok) {
    const guaranteeTasklist = shouldGuaranteeDispatchToTasklist(normalizedInput);
    const failedSessionId = requestedTaskSessionId || normalizedSessionId || callerSessionId || routeSessionId;
    if (failedSessionId) {
      applyExecutionLifecycleTransition(deps.sessionManager, failedSessionId, {
        stage: guaranteeTasklist ? 'dispatching' : 'failed',
        substage: guaranteeTasklist
          ? 'dispatch_binding_mismatch_queued'
          : 'dispatch_binding_mismatch',
        updatedBy: 'dispatch',
        targetAgentId: normalizedInput.targetAgentId,
        lastError: guaranteeTasklist ? null : bindingGuard.error,
        detail: guaranteeTasklist ? bindingGuard.error : undefined,
        recoveryAction: guaranteeTasklist ? 'mailbox' : undefined,
        delivery: guaranteeTasklist ? 'mailbox' : undefined,
      });
    }
    const fallbackDispatchId = `dispatch-binding-mismatch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    logger.module('dispatch').warn(
      guaranteeTasklist
        ? 'Project-task binding mismatch detected; normalized to queued tasklist'
        : 'Rejected dispatch due to immutable project-task binding mismatch',
      {
        sourceAgentId: normalizedInput.sourceAgentId,
        targetAgentId: normalizedInput.targetAgentId,
        taskId: projectTaskIdentity.taskId,
        taskName: projectTaskIdentity.taskName,
        sessionId: requestedTaskSessionId || undefined,
        error: bindingGuard.error,
      },
    );
    if (guaranteeTasklist) {
      return await buildGuaranteedQueuedDispatchResultWithMailbox(deps, normalizedInput, {
        dispatchId: fallbackDispatchId,
        reason: `project-task binding mismatch normalized to queued tasklist: ${bindingGuard.error}`,
        originalStatus: 'failed',
      });
    }
    return {
      ok: false,
      dispatchId: fallbackDispatchId,
      status: 'failed',
      error: bindingGuard.error,
    };
  }
  const projectTaskStateSessionIds = (
    normalizedInput.sourceAgentId === FINGER_SYSTEM_AGENT_ID
    && normalizedInput.targetAgentId === FINGER_PROJECT_AGENT_ID
  )
    ? resolveProjectTaskStateSessionIds(
      originalSessionId,
      normalizedSessionId,
      callerSessionId,
      routeSessionId,
      bindingGuard.boundSessionId,
      canonicalSystemSessionId,
      typeof deps.runtime.getBoundSessionId === 'function'
        ? deps.runtime.getBoundSessionId(FINGER_PROJECT_AGENT_ID) ?? ''
        : '',
    )
    : [];
  const sourceTaskStateActive = isProjectTaskStateActive(sourceTaskState);
  const sameTaskIdentity = isSameProjectTaskIdentity(sourceTaskState, projectTaskIdentity);
  const blockedByValidation = (
    normalizedInput.sourceAgentId === FINGER_SYSTEM_AGENT_ID
    && normalizedInput.targetAgentId === FINGER_PROJECT_AGENT_ID
  )
    ? validateBlockedByForProjectTaskCreation({
      input: normalizedInput,
      sourceTaskState,
      identity: projectTaskIdentity,
    })
    : { ok: true as const, blockedBy: normalizeBlockedByFromDispatch(normalizedInput) ?? sourceTaskState?.blockedBy ?? [BLOCKED_BY_NONE] };
  if (!blockedByValidation.ok) {
    const failedSessionId = requestedTaskSessionId || normalizedSessionId || callerSessionId || routeSessionId;
    if (failedSessionId) {
      applyExecutionLifecycleTransition(deps.sessionManager, failedSessionId, {
        stage: 'failed',
        substage: 'dispatch_blocked_by_invalid',
        updatedBy: 'dispatch',
        targetAgentId: normalizedInput.targetAgentId,
        lastError: blockedByValidation.error,
      });
    }
    return {
      ok: false,
      dispatchId: fallbackDispatchId,
      status: 'failed',
      error: blockedByValidation.error,
    };
  }
  const blockedBy = blockedByValidation.blockedBy;
  if (
    normalizedInput.sourceAgentId === FINGER_SYSTEM_AGENT_ID
    && normalizedInput.targetAgentId === FINGER_PROJECT_AGENT_ID
    && isObjectRecord(normalizedInput.assignment)
  ) {
    normalizedInput = {
      ...normalizedInput,
      assignment: {
        ...normalizedInput.assignment,
        blockedBy,
        ...(assigneeWorkerId ? { assigneeWorkerId } : {}),
        assignerName,
        assigneeName: assigneeWorkerName,
      },
    };
  }
  if (
    normalizedInput.sourceAgentId === FINGER_SYSTEM_AGENT_ID
    && normalizedInput.targetAgentId === FINGER_PROJECT_AGENT_ID
    && assigneeWorkerId
  ) {
    const nextMetadata = isObjectRecord(normalizedInput.metadata)
      ? normalizedInput.metadata
      : {};
    normalizedInput = {
      ...normalizedInput,
      metadata: {
        ...nextMetadata,
        assigneeWorkerId,
        assignerName,
        assigneeWorkerName,
      },
    };
  }
  if (projectTaskStateSessionIds.length > 0) {
    const isNewTaskLifecycle = !sourceTaskStateActive || !sameTaskIdentity;
    const dispatchStateStatus = sourceTaskState?.status === 'in_progress'
      ? 'in_progress'
      : 'dispatched';
    if (isNewTaskLifecycle) {
      persistProjectTaskState(deps, projectTaskStateSessionIds, {
        active: true,
        status: 'create',
        assignerName,
        assigneeWorkerId,
        assigneeWorkerName,
        taskId: projectTaskIdentity.taskId,
        taskName: projectTaskIdentity.taskName,
        sourceAgentId: normalizedInput.sourceAgentId,
        targetAgentId: normalizedInput.targetAgentId,
        boundSessionId: bindingGuard.boundSessionId || requestedTaskSessionId,
        revision: bindingGuard.revision,
        blockedBy,
        note: 'project_task_created',
      });
    }
    persistProjectTaskState(deps, projectTaskStateSessionIds, {
      active: true,
      status: dispatchStateStatus,
      assignerName,
      assigneeWorkerId,
      assigneeWorkerName,
      taskId: projectTaskIdentity.taskId,
      taskName: projectTaskIdentity.taskName,
      sourceAgentId: normalizedInput.sourceAgentId,
      targetAgentId: normalizedInput.targetAgentId,
      boundSessionId: bindingGuard.boundSessionId || requestedTaskSessionId,
      revision: isNewTaskLifecycle ? bindingGuard.revision + 1 : bindingGuard.revision,
      blockedBy,
      note: 'system_dispatched_project_task',
    });
  }

  const unresolvedBlockers = (
    normalizedInput.sourceAgentId === FINGER_SYSTEM_AGENT_ID
    && normalizedInput.targetAgentId === FINGER_PROJECT_AGENT_ID
  )
    ? resolveBlockingDependencies({
      deps,
      sessionIds: projectTaskStateSessionIds,
      blockedBy,
    })
    : [];
  if (unresolvedBlockers.length > 0) {
    const blockerSummary = `blocked by unresolved dependencies: ${unresolvedBlockers.join(', ')}`;
    if (projectTaskStateSessionIds.length > 0) {
      persistProjectTaskState(deps, projectTaskStateSessionIds, {
        active: true,
        status: 'blocked',
        taskId: projectTaskIdentity.taskId,
        taskName: projectTaskIdentity.taskName,
        blockedBy,
        summary: blockerSummary,
        note: 'blocked_by_dependency',
      });
    }
    return {
      ok: true,
      dispatchId: fallbackDispatchId,
      status: 'queued',
      result: sanitizeDispatchResult({
        success: true,
        status: 'blocked_dependencies',
        summary: blockerSummary,
        recoveryAction: 'wait_dependencies',
        delivery: 'queue',
        blockers: unresolvedBlockers,
        blockedBy,
        ...(projectTaskIdentity.taskId ? { taskId: projectTaskIdentity.taskId } : {}),
        ...(projectTaskIdentity.taskName ? { taskName: projectTaskIdentity.taskName } : {}),
      }),
    };
  }

  if (
    normalizedInput.sourceAgentId === FINGER_SYSTEM_AGENT_ID
    && normalizedInput.targetAgentId === FINGER_PROJECT_AGENT_ID
    && sourceTaskStateActive
    && (sameTaskIdentity || (!projectTaskIdentity.taskId && !projectTaskIdentity.taskName))
    && !allowDispatchWhileBusy(normalizedInput)
    && !forceAsyncSystemProjectDispatch
  ) {
    const activeDispatchId = sourceTaskState?.dispatchId || `dispatch-active-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const summaryBase = [
      'source session has active delegated project task',
      sourceTaskState?.status ? `status=${sourceTaskState.status}` : '',
      sourceTaskState?.taskId ? `task=${sourceTaskState.taskId}` : '',
      '- dispatch suppressed; wait for project update/reviewer pass',
    ].filter(Boolean).join(' ');
    const summary = appendProjectTaskHint(summaryBase, {
      status: sourceTaskState?.status,
      taskId: sourceTaskState?.taskId ?? projectTaskIdentity.taskId,
      taskName: sourceTaskState?.taskName ?? projectTaskIdentity.taskName,
      dispatchId: activeDispatchId,
      sourceSessionId: callerSessionId || routeSessionId || normalizedSessionId,
    });
    if (normalizedSessionId) {
      applyExecutionLifecycleTransition(deps.sessionManager, normalizedSessionId, {
        stage: 'dispatching',
        substage: 'dispatch_suppressed_source_task_active',
        updatedBy: 'dispatch',
        dispatchId: activeDispatchId,
        targetAgentId: normalizedInput.targetAgentId,
        detail: summaryBase,
        recoveryAction: 'wait_current_task',
        delivery: 'queue',
      });
    }
    if (projectTaskStateSessionIds.length > 0) {
      persistProjectTaskState(deps, projectTaskStateSessionIds, {
        active: true,
        status: 'in_progress',
        taskId: sourceTaskState?.taskId ?? projectTaskIdentity.taskId,
        taskName: sourceTaskState?.taskName ?? projectTaskIdentity.taskName,
        dispatchId: activeDispatchId,
        summary,
        note: 'dispatch_suppressed_source_task_active',
      });
    }
    logger.module('dispatch').info('Suppressed duplicate system->project dispatch from active source task context', {
      sourceAgentId: normalizedInput.sourceAgentId,
      targetAgentId: normalizedInput.targetAgentId,
      sourceSessionId: callerSessionId,
      selectedSessionId: normalizedSessionId,
      taskId: projectTaskIdentity.taskId,
      taskName: projectTaskIdentity.taskName,
      activeTaskId: sourceTaskState?.taskId,
      activeTaskName: sourceTaskState?.taskName,
      dispatchId: activeDispatchId,
    });
    return {
      ok: true,
      dispatchId: activeDispatchId,
      status: 'queued',
      result: sanitizeDispatchResult({
        success: true,
        status: 'queued_source_task_suppressed',
        summary,
        recoveryAction: 'wait_current_task',
        delivery: 'queue',
        ...(sourceTaskState?.taskId ? { currentTaskId: sourceTaskState.taskId } : {}),
        ...(projectTaskIdentity.taskId ? { taskId: projectTaskIdentity.taskId } : {}),
        ...(projectTaskIdentity.taskName ? { taskName: projectTaskIdentity.taskName } : {}),
      }),
    };
  }

  const activeLifecycle = resolveActiveProjectLifecycleState(deps, normalizedInput);
  if (activeLifecycle.active && !forceAsyncSystemProjectDispatch) {
    const fallbackDispatchId = activeLifecycle.dispatchId || `dispatch-active-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const summaryBase = [
      `target ${normalizedInput.targetAgentId} has active lifecycle`,
      activeLifecycle.stage ? `stage=${activeLifecycle.stage}` : '',
      activeLifecycle.substage ? `substage=${activeLifecycle.substage}` : '',
      activeLifecycle.turnId ? `turn=${activeLifecycle.turnId}` : '',
      '- dispatch suppressed; waiting for project update/reviewer pass',
    ].filter(Boolean).join(' ');
    const summary = appendProjectTaskHint(summaryBase, {
      status: 'in_progress',
      taskId: projectTaskIdentity.taskId,
      taskName: projectTaskIdentity.taskName,
      dispatchId: fallbackDispatchId,
      sourceSessionId: callerSessionId || routeSessionId || normalizedSessionId,
    });
    if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
      applyExecutionLifecycleTransition(deps.sessionManager, normalizedInput.sessionId, {
        stage: 'dispatching',
        substage: 'dispatch_suppressed_active_lifecycle',
        updatedBy: 'dispatch',
        dispatchId: fallbackDispatchId,
        targetAgentId: normalizedInput.targetAgentId,
        detail: summaryBase,
        recoveryAction: 'wait_current_task',
        delivery: 'queue',
      });
    }
    logger.module('dispatch').info('Suppressed system->project dispatch due to active lifecycle', {
      sourceAgentId: normalizedInput.sourceAgentId,
      targetAgentId: normalizedInput.targetAgentId,
      sessionId: normalizedInput.sessionId,
      stage: activeLifecycle.stage,
      substage: activeLifecycle.substage,
      taskId: projectTaskIdentity.taskId,
      taskName: projectTaskIdentity.taskName,
      dispatchId: fallbackDispatchId,
    });
    if (projectTaskStateSessionIds.length > 0) {
      persistProjectTaskState(deps, projectTaskStateSessionIds, {
        active: true,
        status: 'in_progress',
        taskId: projectTaskIdentity.taskId,
        taskName: projectTaskIdentity.taskName,
        dispatchId: fallbackDispatchId,
        summary,
        note: 'dispatch_suppressed_active_lifecycle',
      });
    }
    return {
      ok: true,
      dispatchId: fallbackDispatchId,
      status: 'queued',
      result: sanitizeDispatchResult({
        success: true,
        status: 'queued_active_lifecycle_suppressed',
        summary,
        recoveryAction: 'wait_current_task',
        delivery: 'queue',
        ...(projectTaskIdentity.taskId ? { taskId: projectTaskIdentity.taskId } : {}),
        ...(projectTaskIdentity.taskName ? { taskName: projectTaskIdentity.taskName } : {}),
        ...(activeLifecycle.stage ? { lifecycleStage: activeLifecycle.stage } : {}),
        ...(activeLifecycle.substage ? { lifecycleSubstage: activeLifecycle.substage } : {}),
      }),
    };
  }

  if (
    normalizedInput.sourceAgentId === HEARTBEAT_SOURCE_AGENT_ID
    && normalizedInput.targetAgentId === FINGER_PROJECT_AGENT_ID
    && !allowDispatchWhileBusy(normalizedInput)
  ) {
    const heartbeatTaskState = resolveSourceProjectTaskState(deps, normalizedSessionId)
      ?? resolveSourceProjectTaskState(deps, routeSessionId)
      ?? resolveSourceProjectTaskState(deps, callerSessionId);
    const hasActionableTaskState = isProjectTaskStateActive(heartbeatTaskState);
    if (!hasActionableTaskState && !activeLifecycle.active) {
      const noActionSummary = [
        'No actionable work.',
        heartbeatTaskState?.status ? `state=${heartbeatTaskState.status}.` : '',
        'Heartbeat watchdog dispatch skipped at runtime guard.',
      ].filter(Boolean).join(' ');
      const lifecycleSessionId = normalizedSessionId || callerSessionId || routeSessionId;
      const fallbackSession = lifecycleSessionId ? deps.sessionManager.getSession(lifecycleSessionId) : null;
      const projectPathHint = resolveDispatchProjectPathHint(normalizedInput, fallbackSession?.projectPath);
      let autoClosedMonitor = false;
      let monitorCloseError = '';
      if (projectPathHint) {
        try {
          const monitoredAgent = await setMonitorStatus(projectPathHint, false);
          autoClosedMonitor = monitoredAgent.monitored === false;
        } catch (error) {
          monitorCloseError = error instanceof Error ? error.message : String(error);
          logger.module('dispatch').warn('Failed to auto-close stale project heartbeat monitor', {
            targetAgentId: normalizedInput.targetAgentId,
            sessionId: lifecycleSessionId || undefined,
            projectPathHint,
            error: monitorCloseError,
          });
        }
      }
      const summary = autoClosedMonitor
        ? `${noActionSummary} Auto-closed stale monitor for this project.`
        : noActionSummary;
      if (lifecycleSessionId) {
        applyExecutionLifecycleTransition(deps.sessionManager, lifecycleSessionId, {
          stage: 'completed',
          substage: 'dispatch_heartbeat_no_actionable',
          updatedBy: 'dispatch',
          targetAgentId: normalizedInput.targetAgentId,
          detail: summary,
          finishReason: 'stop',
        });
      }
      const closeSessionIds = resolveProjectTaskStateSessionIds(
        originalSessionId,
        normalizedSessionId,
        callerSessionId,
        routeSessionId,
      );
      if (closeSessionIds.length > 0) {
        persistProjectTaskState(deps, closeSessionIds, {
          active: false,
          status: 'closed',
          taskId: heartbeatTaskState?.taskId,
          taskName: heartbeatTaskState?.taskName,
          dispatchId: heartbeatTaskState?.dispatchId,
          summary,
          note: autoClosedMonitor
            ? 'heartbeat_dispatch_skipped_no_actionable_monitor_closed'
            : 'heartbeat_dispatch_skipped_no_actionable',
          sourceAgentId: FINGER_SYSTEM_AGENT_ID,
          targetAgentId: normalizedInput.targetAgentId,
        });
      }
      logger.module('dispatch').info('Skipped system-heartbeat -> project dispatch due to no actionable state', {
        sessionId: lifecycleSessionId || undefined,
        taskStatus: heartbeatTaskState?.status,
        taskId: heartbeatTaskState?.taskId,
        taskName: heartbeatTaskState?.taskName,
        autoClosedMonitor,
        projectPath: projectPathHint || undefined,
      });
      return {
        ok: true,
        dispatchId: heartbeatTaskState?.dispatchId || `dispatch-heartbeat-skip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        status: 'completed',
        result: sanitizeDispatchResult({
          success: true,
          status: 'skipped_no_actionable',
          summary,
          recoveryAction: 'none',
          delivery: 'queue',
          autoClosedMonitor,
          closeReason: 'expired_no_actionable',
          ...(projectPathHint ? { projectPath: projectPathHint } : {}),
          ...(monitorCloseError ? { monitorCloseError } : {}),
          ...(heartbeatTaskState?.taskId ? { taskId: heartbeatTaskState.taskId } : {}),
          ...(heartbeatTaskState?.taskName ? { taskName: heartbeatTaskState.taskName } : {}),
        }),
      };
    }
  }

  const busyState = await resolveBusyProjectAgentState(deps, normalizedInput);
  if (busyState.busy && !forceAsyncSystemProjectDispatch) {
    const fallbackDispatchId = busyState.dispatchId || `dispatch-busy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const busySummaryBase = [
      `target ${normalizedInput.targetAgentId} busy`,
      busyState.taskId ? `(task=${busyState.taskId})` : '',
      busyState.status ? `status=${busyState.status}` : '',
      '- dispatch suppressed; wait for current task update',
    ].filter(Boolean).join(' ');
    const busySummary = appendProjectTaskHint(busySummaryBase, {
      status: busyState.status ?? 'in_progress',
      taskId: busyState.taskId ?? projectTaskIdentity.taskId,
      taskName: projectTaskIdentity.taskName,
      dispatchId: fallbackDispatchId,
      sourceSessionId: callerSessionId || routeSessionId || normalizedSessionId,
    });
    if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
      applyExecutionLifecycleTransition(deps.sessionManager, normalizedInput.sessionId, {
        stage: 'dispatching',
        substage: 'dispatch_suppressed_target_busy',
        updatedBy: 'dispatch',
        dispatchId: fallbackDispatchId,
        targetAgentId: normalizedInput.targetAgentId,
        detail: busySummaryBase,
        recoveryAction: 'wait_current_task',
        delivery: 'queue',
      });
    }
    logger.module('dispatch').info('Suppressed duplicate system->project dispatch while target is busy', {
      sourceAgentId: normalizedInput.sourceAgentId,
      targetAgentId: normalizedInput.targetAgentId,
      sessionId: normalizedInput.sessionId,
      busyStatus: busyState.status,
      currentTaskId: busyState.taskId,
      taskId: projectTaskIdentity.taskId,
      taskName: projectTaskIdentity.taskName,
      dispatchId: fallbackDispatchId,
    });
    if (projectTaskStateSessionIds.length > 0) {
      persistProjectTaskState(deps, projectTaskStateSessionIds, {
        active: true,
        status: 'in_progress',
        taskId: projectTaskIdentity.taskId,
        taskName: projectTaskIdentity.taskName,
        dispatchId: fallbackDispatchId,
        summary: busySummary,
        note: 'dispatch_suppressed_target_busy',
      });
    }
    return {
      ok: true,
      dispatchId: fallbackDispatchId,
      status: 'queued',
      result: sanitizeDispatchResult({
        success: true,
        status: 'queued_busy_suppressed',
        summary: busySummary,
        recoveryAction: 'wait_current_task',
        delivery: 'queue',
        ...(busyState.taskId ? { currentTaskId: busyState.taskId } : {}),
        ...(projectTaskIdentity.taskId ? { taskId: projectTaskIdentity.taskId } : {}),
        ...(projectTaskIdentity.taskName ? { taskName: projectTaskIdentity.taskName } : {}),
      }),
    };
  }

  if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
    applyExecutionLifecycleTransition(deps.sessionManager, normalizedInput.sessionId, {
      stage: 'dispatching',
      substage: 'normalized',
      updatedBy: 'dispatch',
      targetAgentId: normalizedInput.targetAgentId,
      detail: normalizedInput.sourceAgentId,
      lastError: null,
    });
  }

  await persistDispatchUserMessage(deps, normalizedInput);
  await persistUserMessageToMemory(deps, normalizedInput);

  let result: {
    ok: boolean;
    dispatchId: string;
    status: 'queued' | 'completed' | 'failed';
    result?: DispatchSummaryResult;
    error?: string;
    queuePosition?: number;
  } | undefined;
  let finalExecuteError: unknown;

  for (let attempt = 0; attempt <= DISPATCH_ERROR_MAX_RETRIES; attempt += 1) {
    try {
      result = await deps.agentRuntimeBlock.execute('dispatch', normalizedInput as unknown as Record<string, unknown>) as Exclude<typeof result, undefined>;
      finalExecuteError = undefined;
    } catch (executeError) {
      if (isNonRetriableDispatchFailure(executeError)) {
        const message = executeError instanceof Error ? executeError.message : String(executeError);
        if (shouldGuaranteeDispatchToTasklist(normalizedInput)) {
          result = await buildGuaranteedQueuedDispatchResultWithMailbox(deps, normalizedInput, {
            dispatchId: fallbackDispatchId,
            reason: `non-retriable dispatch error normalized to queued tasklist: ${message}`,
            originalStatus: 'failed',
          });
          finalExecuteError = undefined;
          logger.module('dispatch').warn('Non-retriable dispatch execute error; normalized to queued tasklist without retry', {
            targetAgentId: normalizedInput.targetAgentId,
            sessionId: normalizedInput.sessionId,
            error: message,
          });
          break;
        }
        finalExecuteError = executeError;
        break;
      }
      finalExecuteError = executeError;
      if (attempt >= DISPATCH_ERROR_MAX_RETRIES) break;
      const retryDelayMs = resolveRetryBackoffMs(attempt + 1);
      if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
        applyExecutionLifecycleTransition(deps.sessionManager, normalizedInput.sessionId, {
          stage: 'retrying',
          substage: 'dispatch_execute_throw',
          updatedBy: 'dispatch',
          targetAgentId: normalizedInput.targetAgentId,
          lastError: executeError instanceof Error ? executeError.message : String(executeError),
          detail: `attempt=${attempt + 1}`,
          retryDelayMs,
          recoveryAction: 'retry',
          incrementRetry: true,
        });
      }
      logger.module('dispatch').warn('Dispatch execute threw error, retrying with exponential backoff', {
        retryAttempt: attempt + 1,
        maxRetries: DISPATCH_ERROR_MAX_RETRIES,
        retryDelayMs,
        targetAgentId: normalizedInput.targetAgentId,
        sessionId: normalizedInput.sessionId,
        error: executeError instanceof Error ? executeError.message : String(executeError),
      });
      await sleep(retryDelayMs);
      continue;
    }

    if (shouldAutoDeployForMissingTarget(normalizedInput, result)) {
      const deployRequest = {
        targetAgentId: normalizedInput.targetAgentId,
        sessionId: normalizedInput.sessionId,
        scope: 'session' as const,
        launchMode: 'system' as const,
        instanceCount: resolveAutoDeployInstanceCount(normalizedInput),
      };
      try {
        const deployResult = await deps.agentRuntimeBlock.execute('deploy', deployRequest as unknown as Record<string, unknown>) as {
          success?: boolean;
          error?: string;
        };
        if (deployResult?.success) {
          if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
            applyExecutionLifecycleTransition(deps.sessionManager, normalizedInput.sessionId, {
              stage: 'retrying',
              substage: 'auto_deploy_retry',
              updatedBy: 'dispatch',
              targetAgentId: normalizedInput.targetAgentId,
              detail: `attempt=${attempt + 1}`,
              retryDelayMs: resolveRetryBackoffMs(attempt + 1),
              recoveryAction: 'retry',
              incrementRetry: true,
            });
          }
          logger.module('dispatch').info('Auto-deployed missing target agent before dispatch retry', {
            sourceAgentId: normalizedInput.sourceAgentId,
            targetAgentId: normalizedInput.targetAgentId,
            instanceCount: deployRequest.instanceCount,
            retryAttempt: attempt + 1,
            maxRetries: DISPATCH_ERROR_MAX_RETRIES,
          });
          if (attempt >= DISPATCH_ERROR_MAX_RETRIES) break;
          const retryDelayMs = resolveRetryBackoffMs(attempt + 1);
          await sleep(retryDelayMs);
          continue;
        }
        if (deployResult?.error) {
          logger.module('dispatch').warn('Auto-deploy failed before dispatch retry', {
            targetAgentId: normalizedInput.targetAgentId,
            error: deployResult.error,
          });
        }
      } catch (deployError) {
        logger.module('dispatch').warn('Auto-deploy retry threw error', {
          targetAgentId: normalizedInput.targetAgentId,
          error: deployError instanceof Error ? deployError.message : String(deployError),
        });
      }
    }

    if (result.ok || result.status !== 'failed') {
      break;
    }

    if (isNonRetriableDispatchFailure(result.error)) {
      if (shouldGuaranteeDispatchToTasklist(normalizedInput)) {
        result = await buildGuaranteedQueuedDispatchResultWithMailbox(deps, normalizedInput, {
          dispatchId: result.dispatchId || fallbackDispatchId,
          reason: `non-retriable dispatch failure normalized to queued tasklist: ${result.error || 'dispatch failed'}`,
          originalStatus: result.status,
        });
      }
      break;
    }

    if (attempt >= DISPATCH_ERROR_MAX_RETRIES) {
      break;
    }
    const retryDelayMs = resolveRetryBackoffMs(attempt + 1);
    if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
      applyExecutionLifecycleTransition(deps.sessionManager, normalizedInput.sessionId, {
        stage: 'retrying',
        substage: 'dispatch_result_failed',
        updatedBy: 'dispatch',
        targetAgentId: normalizedInput.targetAgentId,
        lastError: result.error,
        detail: `attempt=${attempt + 1}`,
        retryDelayMs,
        recoveryAction: 'retry',
        incrementRetry: true,
      });
    }
    logger.module('dispatch').warn('Dispatch returned failed result, retrying with exponential backoff', {
      retryAttempt: attempt + 1,
      maxRetries: DISPATCH_ERROR_MAX_RETRIES,
      retryDelayMs,
      targetAgentId: normalizedInput.targetAgentId,
      sessionId: normalizedInput.sessionId,
      error: result.error,
    });
    await sleep(retryDelayMs);
  }

  if (finalExecuteError) {
    const executeError = finalExecuteError;
    const message = executeError instanceof Error ? executeError.message : String(executeError);
    if (shouldGuaranteeDispatchToTasklist(normalizedInput)) {
      const softQueued = await buildGuaranteedQueuedDispatchResultWithMailbox(deps, normalizedInput, {
        dispatchId: fallbackDispatchId,
        reason: `runtime execute error converted to queued tasklist: ${message}`,
        originalStatus: 'failed',
      });
      result = softQueued;
      finalExecuteError = undefined;
    } else {
    logger.module('dispatch').error('AgentRuntimeBlock.execute failed', executeError instanceof Error ? executeError : undefined, {
      dispatchId: fallbackDispatchId,
      targetAgentId: normalizedInput.targetAgentId,
      sessionId: normalizedInput.sessionId,
    });
    // Persist failure to session so the conversation history is complete
    const failSessionId = typeof normalizedInput.sessionId === 'string' ? normalizedInput.sessionId : '';
    if (failSessionId) {
      void deps.sessionManager.addMessage(failSessionId, 'system', '任务派发异常', {
        type: 'dispatch',
        agentId: normalizedInput.targetAgentId,
        metadata: { error: message, dispatchId: fallbackDispatchId },
      });
      applyExecutionLifecycleTransition(deps.sessionManager, failSessionId, {
        stage: 'failed',
        substage: 'dispatch_execute_final_error',
        updatedBy: 'dispatch',
        dispatchId: fallbackDispatchId,
        targetAgentId: normalizedInput.targetAgentId,
        lastError: message,
      });
    }
    await persistAgentSummaryToMemory(deps, normalizedInput, { ok: false, summary: message }, true);
    if (projectTaskStateSessionIds.length > 0) {
      persistProjectTaskState(deps, projectTaskStateSessionIds, {
        active: false,
        status: 'failed',
        taskId: projectTaskIdentity.taskId,
        taskName: projectTaskIdentity.taskName,
        dispatchId: fallbackDispatchId,
        summary: message,
        note: 'dispatch_execute_final_error',
      });
    }
    return { ok: false, dispatchId: fallbackDispatchId, status: 'failed', error: message };
    }
  }
  if (!result) {
    if (shouldGuaranteeDispatchToTasklist(normalizedInput)) {
      result = await buildGuaranteedQueuedDispatchResultWithMailbox(deps, normalizedInput, {
        dispatchId: fallbackDispatchId,
        reason: 'runtime returned empty result after retries; normalized to queued tasklist',
        originalStatus: 'failed',
      });
    } else {
    if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
      applyExecutionLifecycleTransition(deps.sessionManager, normalizedInput.sessionId, {
        stage: 'failed',
        substage: 'dispatch_result_empty',
        updatedBy: 'dispatch',
        targetAgentId: normalizedInput.targetAgentId,
        lastError: 'dispatch result is empty after retries',
      });
    }
    if (projectTaskStateSessionIds.length > 0) {
      persistProjectTaskState(deps, projectTaskStateSessionIds, {
        active: false,
        status: 'failed',
        taskId: projectTaskIdentity.taskId,
        taskName: projectTaskIdentity.taskName,
        dispatchId: fallbackDispatchId,
        summary: 'dispatch result is empty after retries',
        note: 'dispatch_result_empty',
      });
    }
    return { ok: false, dispatchId: fallbackDispatchId, status: 'failed', error: 'dispatch result is empty after retries' };
    }
  }

  if (result.status === 'failed' && shouldGuaranteeDispatchToTasklist(normalizedInput)) {
    const reason = asTrimmedString(result.error) || 'runtime returned failed status';
    result = await buildGuaranteedQueuedDispatchResultWithMailbox(deps, normalizedInput, {
      dispatchId: result.dispatchId || fallbackDispatchId,
      reason: `${reason}; normalized to queued tasklist`,
      originalStatus: 'failed',
    });
  }

  if (
    normalizedInput.sourceAgentId === FINGER_SYSTEM_AGENT_ID
    && normalizedInput.targetAgentId === FINGER_PROJECT_AGENT_ID
    && result.result?.summary
  ) {
    result.result.summary = appendProjectTaskHint(result.result.summary, {
      status: result.status === 'failed' ? 'failed' : 'in_progress',
      taskId: projectTaskIdentity.taskId,
      taskName: projectTaskIdentity.taskName,
      dispatchId: result.dispatchId,
      sourceSessionId: callerSessionId || routeSessionId || normalizedSessionId,
    });
  }

  if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
    const rawProjectionResult = result.result?.rawPayload ?? result.result;
    const kernelMetadata = extractKernelMetadataFromAgentResult(rawProjectionResult);
    if (kernelMetadataHasCompactedProjection(kernelMetadata)) {
      deps.sessionManager.syncProjectionFromKernelMetadata(
        normalizedInput.sessionId,
        kernelMetadata,
        {
          agentId: normalizedInput.targetAgentId,
          assistantReply: extractResultTextForSession(rawProjectionResult) ?? undefined,
        },
      );
    }
  }

  if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
    const mailboxQueued = result.status === 'queued'
      && (result.result?.status === 'queued_mailbox' || typeof result.result?.messageId === 'string');
    applyExecutionLifecycleTransition(deps.sessionManager, normalizedInput.sessionId, {
      stage: resolveLifecycleStageFromResultStatus(result.status) ?? (result.ok ? 'completed' : 'failed'),
      substage: result.status === 'queued'
        ? (mailboxQueued ? 'dispatch_mailbox_wait_ack' : 'dispatch_queued')
        : result.status === 'completed'
          ? 'dispatch_completed'
          : 'dispatch_failed',
      updatedBy: 'dispatch',
      dispatchId: result.dispatchId,
      targetAgentId: normalizedInput.targetAgentId,
      lastError: result.ok ? null : (result.error ?? null),
      detail: result.result?.summary?.slice(0, 120) ?? result.error,
      timeoutMs: typeof result.result?.timeoutMs === 'number' ? result.result.timeoutMs : undefined,
      retryDelayMs: typeof result.result?.retryDelayMs === 'number' ? result.result.retryDelayMs : undefined,
      recoveryAction: mailboxQueued
        ? (result.result?.recoveryAction ?? 'mailbox')
        : result.ok
          ? (result.result?.recoveryAction ?? 'completed')
          : (result.result?.recoveryAction ?? 'failed'),
      delivery: mailboxQueued
        ? (result.result?.delivery ?? 'mailbox')
        : result.status === 'queued'
          ? (result.result?.delivery ?? 'queue')
          : result.result?.delivery ?? null,
    });
  }

  const newSessionId = typeof normalizedInput.sessionId === 'string' ? normalizedInput.sessionId.trim() : '';
  if (originalSessionId && newSessionId && originalSessionId !== newSessionId && result.dispatchId) {
    const tracker = getGlobalDispatchTracker();
    tracker.track({
      dispatchId: result.dispatchId,
      parentSessionId: originalSessionId,
      childSessionId: newSessionId,
      sourceAgentId: input.sourceAgentId,
      targetAgentId: input.targetAgentId,
    });
  }
  if (result.result !== undefined) {
    result.result = sanitizeDispatchResult(result.result);
    result.result = enrichDispatchTagsAndTopic(result.result, {
      task: normalizedInput.task,
      targetAgentId: normalizedInput.targetAgentId,
      sourceAgentId: normalizedInput.sourceAgentId,
    });
  }
  // Always record result to memory (success or failure)
  const summaryForMemory = result.result?.summary || result.error || undefined;
  if (summaryForMemory) {
    await persistAgentSummaryToMemory(deps, normalizedInput, { ok: result.ok, summary: summaryForMemory });
  }
  // Write dispatch result to session for all channels (unified ledger writing)
  // CRITICAL: Store FULL rawPayload in ledger - NEVER truncate
  const dispatchSessionId = typeof normalizedInput.sessionId === 'string' ? normalizedInput.sessionId.trim() : '';
  if (dispatchSessionId) {
    const dispatchSession = deps.sessionManager.getSession(dispatchSessionId);
    if (dispatchSession) {
      // Summary is for display (can be truncated), rawPayload is for ledger (NEVER truncated)
      const replyContent = result.ok
        ? (result.result?.summary || '处理完成')
        : `处理失败：${result.error || '未知错误'}`;

      // Build metadata with FULL rawPayload for ledger storage
      const ledgerMetadata: Record<string, unknown> = {
        source: 'dispatch',
        dispatchId: result.dispatchId,
        status: result.status,
        agentId: normalizedInput.targetAgentId,
        // Store full raw result for ledger - this is the single source of truth
        rawResult: result.result?.rawPayload ?? result.result,
      };
      if (result.error) ledgerMetadata.error = result.error;
      if (result.result?.tags) ledgerMetadata.tags = result.result.tags;
      if (result.result?.topic) ledgerMetadata.topic = result.result.topic;

      void deps.sessionManager.addMessage(dispatchSessionId, 'assistant', replyContent, {
        type: 'dispatch',
        agentId: normalizedInput.targetAgentId,
        metadata: ledgerMetadata,
      });
    }
  }
  await syncBdDispatchLifecycle(deps, normalizedInput, result);
  if (projectTaskStateSessionIds.length > 0) {
    const mappedStatus = result.status === 'failed'
      ? 'failed'
      : sourceTaskState?.status === 'in_progress'
        ? 'in_progress'
        : 'accepted';
    const shouldStayActive = result.status !== 'failed';
    persistProjectTaskState(deps, projectTaskStateSessionIds, {
      active: shouldStayActive,
      status: mappedStatus,
      taskId: projectTaskIdentity.taskId,
      taskName: projectTaskIdentity.taskName,
      dispatchId: result.dispatchId,
      blockedBy,
      summary: result.result?.summary ?? result.error,
      note: result.status === 'failed'
        ? 'dispatch_failed'
        : result.status === 'queued'
          ? 'dispatch_accepted_queued'
          : 'dispatch_accepted',
    });
  }
  return result;
}
