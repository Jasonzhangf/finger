import path from 'path';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { InternalTool, createToolExecutionContext, type ToolExecutionContext } from './types.js';
import { logger } from '../../core/logger.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';

type LegacyPlanStepStatus = 'pending' | 'in_progress' | 'completed';
type PlanPriority = 'P0' | 'P1' | 'P2' | 'P3';
type PlanType = 'epic' | 'task' | 'subtask' | 'review';
type PlanStatus = 'open' | 'in_progress' | 'blocked' | 'review_pending' | 'done' | 'closed';
type UpdatePlanAction =
  | 'create'
  | 'update'
  | 'list'
  | 'search'
  | 'claim'
  | 'reassign'
  | 'set_status'
  | 'set_dependency'
  | 'append_evidence'
  | 'close'
  | 'archive';

type UpdatePlanErrorCode =
  | 'invalid_transition'
  | 'revision_conflict'
  | 'permission_denied'
  | 'scope_mismatch'
  | 'not_found'
  | 'validation_error';

interface LegacyPlanItem {
  step: string;
  status: LegacyPlanStepStatus;
}

export interface PlanEvidence {
  id: string;
  timestamp: string;
  type: string;
  content: string;
  ref?: string;
}

export interface PlanEvent {
  id: string;
  timestamp: string;
  action: UpdatePlanAction;
  projectPath: string;
  itemId?: string;
  actorAgentId?: string;
  statusFrom?: PlanStatus;
  statusTo?: PlanStatus;
  summary: string;
}

export interface PlanItemV2 {
  id: string;
  type: PlanType;
  title: string;
  description: string;
  status: PlanStatus;
  priority: PlanPriority;
  projectPath: string;
  assigneeWorkerId: string;
  reporterAgentId: string;
  blockedBy: string[];
  dependsOn: string[];
  acceptanceCriteria: string[];
  evidence: PlanEvidence[];
  createdAt: string;
  updatedAt: string;
  revision: number;
  archivedAt?: string;
}

interface UpdatePlanLegacyInput {
  explanation?: string;
  plan: LegacyPlanItem[];
}

interface UpdatePlanV2Input {
  action: UpdatePlanAction;
  projectPath?: string;
  id?: string;
  query?: string;
  expectedRevision?: number;
  item?: Partial<PlanItemV2> & Record<string, unknown>;
  patch?: Partial<PlanItemV2> & Record<string, unknown>;
  status?: PlanStatus | string;
  blockedBy?: string[];
  dependsOn?: string[];
  assigneeWorkerId?: string;
  evidence?: {
    type?: string;
    content?: string;
    ref?: string;
  };
  explanation?: string;
}

export interface UpdatePlanOutput {
  ok: boolean;
  content: string;
  explanation?: string;
  plan: LegacyPlanItem[];
  updatedAt: string;
  action?: UpdatePlanAction | 'legacy';
  projectPath?: string;
  item?: PlanItemV2;
  items?: PlanItemV2[];
  events?: PlanEvent[];
  planEvent?: PlanEvent;
  errorCode?: UpdatePlanErrorCode;
  error?: string;
}

interface StoredPlanState {
  byProjectPath: Map<string, Map<string, PlanItemV2>>;
  eventsByProjectPath: Map<string, PlanEvent[]>;
}

const store: StoredPlanState = {
  byProjectPath: new Map(),
  eventsByProjectPath: new Map(),
};
const UPDATE_PLAN_STORE_VERSION = 1;
let storeLoaded = false;

function resolveUpdatePlanStoreFile(): string {
  return process.env.FINGER_UPDATE_PLAN_STORE_FILE?.trim()
    || path.join(FINGER_PATHS.runtime.dir, 'update-plan-store.json');
}

const STATUS_TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  open: ['in_progress', 'blocked'],
  in_progress: ['blocked', 'review_pending', 'open'],
  blocked: ['open', 'in_progress'],
  review_pending: ['in_progress', 'blocked', 'done'],
  done: ['closed'],
  closed: [],
};

let lastPlanSnapshot: UpdatePlanOutput | null = null;

export const updatePlanTool: InternalTool<unknown, UpdatePlanOutput> = {
  name: 'update_plan',
  executionModel: 'state',
  description: [
    'Unified project plan manager (BD-aligned).',
    'Supports actions:',
    'create/update/list/search/claim/reassign/set_status/set_dependency/append_evidence/close/archive.',
    'Write actions require expectedRevision (CAS).',
    'Backward-compatible with legacy { plan: [{ step, status }] } payload.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string' },
      explanation: { type: 'string' },
      projectPath: { type: 'string' },
      id: { type: 'string' },
      query: { type: 'string' },
      expectedRevision: { type: 'number' },
      status: { type: 'string' },
      assigneeWorkerId: { type: 'string' },
      blockedBy: { type: 'array', items: { type: 'string' } },
      dependsOn: { type: 'array', items: { type: 'string' } },
      item: { type: 'object' },
      patch: { type: 'object' },
      evidence: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          content: { type: 'string' },
          ref: { type: 'string' },
        },
        required: ['type', 'content'],
      },
      plan: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            step: { type: 'string' },
            status: { type: 'string' },
          },
          required: ['step', 'status'],
        },
      },
    },
    additionalProperties: true,
  },
  execute: async (rawInput: unknown, rawContext?: ToolExecutionContext): Promise<UpdatePlanOutput> => {
    ensureStoreLoaded();
    const context = rawContext ?? createToolExecutionContext();
    const now = new Date().toISOString();
    const parsed = parseInput(rawInput);

    if (parsed.mode === 'legacy') {
      const output: UpdatePlanOutput = {
        ok: true,
        content: 'Plan updated',
        explanation: parsed.input.explanation,
        plan: parsed.input.plan,
        updatedAt: now,
        action: 'legacy',
      };
      lastPlanSnapshot = output;
      return output;
    }

    const result = handleV2Action(parsed.input, context, now);
    if (result.ok && isWriteV2Action(parsed.input.action)) {
      persistStore();
    }
    lastPlanSnapshot = result;
    return result;
  },
};

export function getLastPlanSnapshot(): UpdatePlanOutput | null {
  if (!lastPlanSnapshot) return null;
  return cloneOutput(lastPlanSnapshot);
}

export function resetUpdatePlanToolState(): void {
  store.byProjectPath.clear();
  store.eventsByProjectPath.clear();
  lastPlanSnapshot = null;
  storeLoaded = true;
  try {
    const storeFile = resolveUpdatePlanStoreFile();
    if (existsSync(storeFile)) {
      rmSync(storeFile, { force: true });
    }
  } catch {
    // best effort for tests/runtime reset
  }
}

export function reloadUpdatePlanToolStateFromDiskForTest(): void {
  store.byProjectPath.clear();
  store.eventsByProjectPath.clear();
  lastPlanSnapshot = null;
  storeLoaded = false;
  ensureStoreLoaded();
}

export interface AutoArchiveProjectPlanParams {
  projectPath: string;
  taskId?: string;
  taskName?: string;
  assigneeWorkerId?: string;
  sourceAgentId?: string;
  note?: string;
}

export interface AutoArchiveProjectPlanResult {
  ok: boolean;
  projectPath: string;
  archivedItemIds: string[];
  strategy: 'task_match' | 'worker_latest' | 'single_open' | 'none';
}

/**
 * Auto-archive completed plan items for a closed project task.
 * Scope is strictly limited to the provided projectPath to avoid cross-project pollution.
 */
export function autoArchiveProjectPlanOnTaskClosed(
  params: AutoArchiveProjectPlanParams,
): AutoArchiveProjectPlanResult {
  ensureStoreLoaded();
  const projectPath = resolveProjectPath(params.projectPath, process.cwd());
  const projectStore = store.byProjectPath.get(projectPath);
  if (!projectStore || projectStore.size === 0) {
    return {
      ok: true,
      projectPath,
      archivedItemIds: [],
      strategy: 'none',
    };
  }

  const openItems = Array.from(projectStore.values()).filter((item) => item.status !== 'closed' && !item.archivedAt);
  if (openItems.length === 0) {
    return {
      ok: true,
      projectPath,
      archivedItemIds: [],
      strategy: 'none',
    };
  }

  const normalizedTaskName = normalizeComparableText(params.taskName);
  const normalizedTaskId = normalizeComparableText(params.taskId);
  const normalizedWorkerId = normalizeComparableText(params.assigneeWorkerId);

  let candidates = openItems.filter((item) => {
    if (!normalizedTaskName && !normalizedTaskId) return false;
    const title = normalizeComparableText(item.title);
    const description = normalizeComparableText(item.description);
    const id = normalizeComparableText(item.id);
    return (normalizedTaskId && id === normalizedTaskId)
      || (normalizedTaskName && (title.includes(normalizedTaskName) || description.includes(normalizedTaskName)));
  });

  let strategy: AutoArchiveProjectPlanResult['strategy'] = 'none';
  if (candidates.length > 0) {
    strategy = 'task_match';
  } else if (normalizedWorkerId) {
    const workerItems = openItems
      .filter((item) => normalizeComparableText(item.assigneeWorkerId) === normalizedWorkerId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    if (workerItems.length > 0) {
      candidates = [workerItems[0]];
      strategy = 'worker_latest';
    }
  }

  if (candidates.length === 0 && openItems.length === 1) {
    candidates = [openItems[0]];
    strategy = 'single_open';
  }

  if (candidates.length === 0) {
    return {
      ok: true,
      projectPath,
      archivedItemIds: [],
      strategy: 'none',
    };
  }

  const now = new Date().toISOString();
  const eventCtx = createToolExecutionContext({
    cwd: projectPath,
    agentId: params.sourceAgentId || 'finger-system-agent',
  });
  const archivedItemIds: string[] = [];
  for (const candidate of candidates) {
    const next: PlanItemV2 = {
      ...candidate,
      status: 'closed',
      updatedAt: now,
      revision: candidate.revision + 1,
      archivedAt: now,
    };
    projectStore.set(next.id, next);
    archivedItemIds.push(next.id);
    appendPlanEvent({
      now,
      action: 'archive',
      projectPath,
      context: eventCtx,
      itemId: next.id,
      statusFrom: candidate.status,
      statusTo: 'closed',
      summary: params.note?.trim() || `auto-archived ${next.id} on task closure`,
    });
  }
  persistStore();
  return {
    ok: true,
    projectPath,
    archivedItemIds,
    strategy,
  };
}

export interface UpdatePlanRuntimeViewParams {
  agentId?: string;
  cwd?: string;
  projectPath?: string;
  includeClosed?: boolean;
  maxItems?: number;
  maxEvents?: number;
}

export interface UpdatePlanRuntimeView {
  actorRole: ActorRole;
  scope: 'all' | string;
  items: PlanItemV2[];
  events: PlanEvent[];
}

export function getUpdatePlanRuntimeView(params: UpdatePlanRuntimeViewParams = {}): UpdatePlanRuntimeView {
  const actorRole = resolveActorRole(params.agentId);
  const includeClosed = params.includeClosed === true;
  const maxItems = Number.isFinite(params.maxItems) ? Math.max(1, Math.floor(params.maxItems as number)) : 30;
  const maxEvents = Number.isFinite(params.maxEvents) ? Math.max(1, Math.floor(params.maxEvents as number)) : 30;

  if (actorRole === 'system' && !params.projectPath) {
    const allItems = listAllItems();
    const visibleItems = includeClosed
      ? allItems
      : allItems.filter((item) => item.status !== 'closed' && !item.archivedAt);
    const items = sortItems(visibleItems).slice(0, maxItems);
    const events = listAllEvents()
      .filter((event) => includeClosed || event.action !== 'archive')
      .slice(0, maxEvents)
      .map((event) => deepClone(event));
    return {
      actorRole,
      scope: 'all',
      items,
      events,
    };
  }

  const projectPath = resolveProjectPath(params.projectPath, params.cwd ?? process.cwd());
  const scopedStore = store.byProjectPath.get(projectPath);
  const scopedEvents = store.eventsByProjectPath.get(projectPath) ?? [];
  const scopedItems = scopedStore ? Array.from(scopedStore.values()) : [];
  const readable = filterReadableItems(scopedItems, actorRole);
  const visibleItems = includeClosed
    ? readable
    : readable.filter((item) => item.status !== 'closed' && !item.archivedAt);
  const items = sortItems(visibleItems).slice(0, maxItems);
  const events = [...scopedEvents]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, maxEvents)
    .map((event) => deepClone(event));
  return {
    actorRole,
    scope: projectPath,
    items,
    events,
  };
}

function parseInput(rawInput: unknown): { mode: 'legacy'; input: UpdatePlanLegacyInput } | { mode: 'v2'; input: UpdatePlanV2Input } {
  if (!isRecord(rawInput)) {
    throw new Error('update_plan input must be an object');
  }

  if (typeof rawInput.action === 'string' && rawInput.action.trim().length > 0) {
    return { mode: 'v2', input: parseV2Input(rawInput) };
  }

  return { mode: 'legacy', input: parseLegacyInput(rawInput) };
}

function parseLegacyInput(rawInput: Record<string, unknown>): UpdatePlanLegacyInput {
  if (!Array.isArray(rawInput.plan)) {
    throw new Error('update_plan input.plan must be an array');
  }

  const plan: LegacyPlanItem[] = [];
  let inProgressCount = 0;
  const log = logger.module('update-plan');

  for (const item of rawInput.plan) {
    if (!isRecord(item)) {
      throw new Error('update_plan input.plan items must be objects');
    }

    let stepValue: string | undefined;
    if (typeof item.step === 'string' && item.step.trim().length > 0) {
      stepValue = item.step.trim();
    } else {
      const fallback = typeof item.description === 'string'
        ? item.description
        : typeof item.text === 'string'
          ? item.text
          : typeof item.title === 'string'
            ? item.title
            : undefined;
      if (typeof fallback === 'string' && fallback.trim().length > 0) {
        log.warn('[update_plan] Missing step; normalized from fallback field', {
          fallbackField: typeof item.description === 'string'
            ? 'description'
            : typeof item.text === 'string'
              ? 'text'
              : 'title',
        });
        stepValue = fallback.trim();
      } else {
        throw new Error('update_plan plan item.step must be a non-empty string');
      }
    }

    const normalizedStatus = normalizeLegacyStepStatus(item.status);
    if (!normalizedStatus) {
      throw new Error('update_plan plan item.status must be pending|in_progress|completed');
    }
    if (normalizedStatus === 'in_progress') inProgressCount += 1;
    plan.push({ step: stepValue, status: normalizedStatus });
  }

  if (inProgressCount > 1) {
    throw new Error('update_plan allows at most one step with status=in_progress');
  }

  const parsed: UpdatePlanLegacyInput = { plan };
  if (typeof rawInput.explanation === 'string' && rawInput.explanation.trim().length > 0) {
    parsed.explanation = rawInput.explanation.trim();
  }
  return parsed;
}

function parseV2Input(rawInput: Record<string, unknown>): UpdatePlanV2Input {
  const action = typeof rawInput.action === 'string' ? rawInput.action.trim() as UpdatePlanAction : '';
  if (!isUpdatePlanAction(action)) {
    throw new Error('update_plan action must be create|update|list|search|claim|reassign|set_status|set_dependency|append_evidence|close|archive');
  }

  const parsed: UpdatePlanV2Input = { action };
  if (typeof rawInput.projectPath === 'string' && rawInput.projectPath.trim().length > 0) parsed.projectPath = rawInput.projectPath.trim();
  if (typeof rawInput.id === 'string' && rawInput.id.trim().length > 0) parsed.id = rawInput.id.trim();
  if (typeof rawInput.query === 'string' && rawInput.query.trim().length > 0) parsed.query = rawInput.query.trim();
  if (Number.isFinite(rawInput.expectedRevision)) parsed.expectedRevision = Math.max(1, Math.floor(rawInput.expectedRevision as number));
  if (isRecord(rawInput.item)) parsed.item = rawInput.item;
  if (isRecord(rawInput.patch)) parsed.patch = rawInput.patch;
  if (typeof rawInput.status === 'string' && rawInput.status.trim().length > 0) parsed.status = rawInput.status.trim();
  if (Array.isArray(rawInput.blockedBy)) parsed.blockedBy = rawInput.blockedBy.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
  if (Array.isArray(rawInput.dependsOn)) parsed.dependsOn = rawInput.dependsOn.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
  if (typeof rawInput.assigneeWorkerId === 'string' && rawInput.assigneeWorkerId.trim().length > 0) parsed.assigneeWorkerId = rawInput.assigneeWorkerId.trim();
  if (isRecord(rawInput.evidence)) {
    parsed.evidence = {
      type: typeof rawInput.evidence.type === 'string' ? rawInput.evidence.type.trim() : '',
      content: typeof rawInput.evidence.content === 'string' ? rawInput.evidence.content.trim() : '',
      ...(typeof rawInput.evidence.ref === 'string' && rawInput.evidence.ref.trim().length > 0
        ? { ref: rawInput.evidence.ref.trim() }
        : {}),
    };
  }
  if (typeof rawInput.explanation === 'string' && rawInput.explanation.trim().length > 0) parsed.explanation = rawInput.explanation.trim();
  return parsed;
}

function handleV2Action(input: UpdatePlanV2Input, context: ToolExecutionContext, now: string): UpdatePlanOutput {
  const actorRole = resolveActorRole(context.agentId);
  const projectPath = resolveProjectPath(input.projectPath, context.cwd);
  if (!hasScopeAccess(projectPath, context, actorRole)) {
    return buildErrorOutput({
      now,
      action: input.action,
      projectPath,
      code: 'scope_mismatch',
      message: 'update_plan scope mismatch for current context',
    });
  }

  const projectStore = ensureProjectStore(projectPath);

  switch (input.action) {
    case 'create':
      return handleCreate(input, context, actorRole, projectPath, projectStore, now);
    case 'list':
      if (actorRole === 'system' && !input.projectPath) {
        const items = sortItems(listAllItems());
        const events = listAllEvents().slice(0, 100);
        return buildSuccessOutput({
          now,
          action: 'list',
          projectPath: 'all',
          items,
          events,
          content: `Listed ${items.length} plan items across all projects`,
        });
      }
      const readableItems = sortItems(filterReadableItems(Array.from(projectStore.values()), actorRole));
      const events = ensureProjectEventStore(projectPath).slice(-50).map((event) => deepClone(event));
      return buildSuccessOutput({
        now,
        action: 'list',
        projectPath,
        items: readableItems,
        events,
        content: `Listed ${readableItems.length} plan items`,
      });
    case 'search':
      return handleSearch(input, actorRole, projectPath, projectStore, now);
    case 'update':
      return handleUpdate(input, context, projectPath, projectStore, now);
    case 'claim':
      return handleClaim(input, context, projectPath, projectStore, now);
    case 'reassign':
      return handleReassign(input, context, projectPath, projectStore, now);
    case 'set_status':
      return handleSetStatus(input, context, projectPath, projectStore, now);
    case 'set_dependency':
      return handleSetDependency(input, context, projectPath, projectStore, now);
    case 'append_evidence':
      return handleAppendEvidence(input, context, projectPath, projectStore, now);
    case 'close':
      return handleClose(input, context, projectPath, projectStore, now);
    case 'archive':
      return handleArchive(input, context, projectPath, projectStore, now);
    default:
      return buildErrorOutput({
        now,
        action: input.action,
        projectPath,
        code: 'validation_error',
        message: `unsupported action: ${input.action satisfies never}`,
      });
  }
}

function handleCreate(
  input: UpdatePlanV2Input,
  context: ToolExecutionContext,
  actorRole: ActorRole,
  projectPath: string,
  projectStore: Map<string, PlanItemV2>,
  now: string,
): UpdatePlanOutput {
  const itemInput = isRecord(input.item) ? input.item : {};
  const title = readNonEmptyString(itemInput.title);
  if (!title) {
    return buildErrorOutput({
      now,
      action: 'create',
      projectPath,
      code: 'validation_error',
      message: 'create requires item.title',
    });
  }

  const providedId = readNonEmptyString(itemInput.id);
  const id = providedId || generatePlanId();
  if (projectStore.has(id)) {
    return buildErrorOutput({
      now,
      action: 'create',
      projectPath,
      code: 'revision_conflict',
      message: `plan item already exists: ${id}`,
    });
  }

  const type = normalizePlanType(itemInput.type) ?? 'task';
  const status = normalizePlanStatus(itemInput.status) ?? 'open';
  const priority = normalizePlanPriority(itemInput.priority) ?? 'P2';
  const blockedBy = normalizeDependencyArray(itemInput.blockedBy, ['none']);
  if (hasMixedNoneDependency(blockedBy)) {
    return buildErrorOutput({
      now,
      action: 'create',
      projectPath,
      code: 'validation_error',
      message: 'blockedBy cannot mix "none" with concrete dependency ids',
    });
  }
  const dependsOn = normalizeDependencyArray(itemInput.dependsOn, []);
  const acceptanceCriteria = normalizeStringArray(itemInput.acceptanceCriteria);
  const assigneeWorkerId = readNonEmptyString(itemInput.assigneeWorkerId) || context.agentId || 'unassigned';
  if (actorRole === 'worker' && context.agentId && assigneeWorkerId !== context.agentId) {
    return buildErrorOutput({
      now,
      action: 'create',
      projectPath,
      code: 'permission_denied',
      message: 'worker can only create plans assigned to self',
    });
  }
  const reporterAgentId = context.agentId || readNonEmptyString(itemInput.reporterAgentId) || 'unknown';
  const description = readNonEmptyString(itemInput.description) || '';

  const created: PlanItemV2 = {
    id,
    type,
    title,
    description,
    status,
    priority,
    projectPath,
    assigneeWorkerId,
    reporterAgentId,
    blockedBy,
    dependsOn,
    acceptanceCriteria,
    evidence: [],
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
  if (created.status === 'in_progress') {
    const blockers = resolveUnmetBlockers(created, projectStore);
    if (blockers.length > 0) {
      return buildErrorOutput({
        now,
        action: 'create',
        projectPath,
        code: 'invalid_transition',
        message: `cannot create in_progress while blockers unresolved: ${blockers.join(', ')}`,
      });
    }
  }

  projectStore.set(created.id, created);
  const event = appendPlanEvent({
    now,
    action: 'create',
    projectPath,
    context,
    itemId: created.id,
    summary: `created ${created.id}`,
  });
  return buildSuccessOutput({
    now,
    action: 'create',
    projectPath,
    item: created,
    items: [created],
    planEvent: event,
    content: `Created plan item ${created.id}`,
    explanation: input.explanation,
  });
}

function handleSearch(
  input: UpdatePlanV2Input,
  actorRole: ActorRole,
  projectPath: string,
  projectStore: Map<string, PlanItemV2>,
  now: string,
): UpdatePlanOutput {
  const query = (input.query || '').trim().toLowerCase();
  const baseItems = actorRole === 'system' && !input.projectPath
    ? listAllItems()
    : filterReadableItems(Array.from(projectStore.values()), actorRole);
  const effectiveProjectPath = actorRole === 'system' && !input.projectPath ? 'all' : projectPath;
  const items = sortItems(baseItems)
    .filter((item) => {
      if (!query) return true;
      return item.id.toLowerCase().includes(query)
        || item.title.toLowerCase().includes(query)
        || item.description.toLowerCase().includes(query)
        || item.status.toLowerCase().includes(query)
        || item.assigneeWorkerId.toLowerCase().includes(query);
    });
  return buildSuccessOutput({
    now,
    action: 'search',
    projectPath: effectiveProjectPath,
    items,
    content: `Found ${items.length} plan items`,
  });
}

function handleUpdate(
  input: UpdatePlanV2Input,
  context: ToolExecutionContext,
  projectPath: string,
  projectStore: Map<string, PlanItemV2>,
  now: string,
): UpdatePlanOutput {
  const id = readNonEmptyString(input.id) || readNonEmptyString(isRecord(input.patch) ? input.patch.id : undefined);
  if (!id) return buildMissingId('update', projectPath, now);

  const current = projectStore.get(id);
  if (!current) return buildNotFound('update', projectPath, id, now);
  if (!checkExpectedRevision(input.expectedRevision, current.revision)) {
    return buildRevisionConflict('update', projectPath, id, current.revision, now);
  }
  if (!canWriteItem(context, current)) {
    return buildPermissionDenied('update', projectPath, id, now);
  }
  const patch = isRecord(input.patch) ? input.patch : {};
  const actorRole = resolveActorRole(context.agentId);
  const patchAssignee = readNonEmptyString(patch.assigneeWorkerId);
  if (actorRole === 'worker' && patchAssignee && patchAssignee !== current.assigneeWorkerId) {
    return buildErrorOutput({
      now,
      action: 'update',
      projectPath,
      code: 'permission_denied',
      message: 'worker cannot reassign owner of plan item; keep assignee unchanged',
    });
  }
  if (Array.isArray(patch.blockedBy) && hasMixedNoneDependency(normalizeDependencyArray(patch.blockedBy, []))) {
    return buildErrorOutput({
      now,
      action: 'update',
      projectPath,
      code: 'validation_error',
      message: 'blockedBy cannot mix "none" with concrete dependency ids',
    });
  }

  const nextStatus = normalizePlanStatus(patch.status) ?? current.status;
  const statusCheck = validateTransition(current.status, nextStatus);
  if (!statusCheck.ok) return buildInvalidTransition('update', projectPath, id, current.status, nextStatus, now);

  const next: PlanItemV2 = {
    ...current,
    title: readNonEmptyString(patch.title) || current.title,
    description: typeof patch.description === 'string' ? patch.description.trim() : current.description,
    type: normalizePlanType(patch.type) ?? current.type,
    status: nextStatus,
    priority: normalizePlanPriority(patch.priority) ?? current.priority,
    assigneeWorkerId: readNonEmptyString(patch.assigneeWorkerId) || current.assigneeWorkerId,
    blockedBy: Array.isArray(patch.blockedBy) ? normalizeDependencyArray(patch.blockedBy, current.blockedBy) : current.blockedBy,
    dependsOn: Array.isArray(patch.dependsOn) ? normalizeDependencyArray(patch.dependsOn, current.dependsOn) : current.dependsOn,
    acceptanceCriteria: Array.isArray(patch.acceptanceCriteria)
      ? normalizeStringArray(patch.acceptanceCriteria)
      : current.acceptanceCriteria,
    updatedAt: now,
    revision: current.revision + 1,
  };
  if (next.status === 'in_progress') {
    const blockers = resolveUnmetBlockers(next, projectStore);
    if (blockers.length > 0) {
      return buildErrorOutput({
        now,
        action: 'update',
        projectPath,
        code: 'invalid_transition',
        message: `blockedBy unresolved, cannot set in_progress: ${blockers.join(', ')}`,
      });
    }
  }
  projectStore.set(id, next);
  const updateEvent = appendPlanEvent({
    now,
    action: 'update',
    projectPath,
    context,
    itemId: next.id,
    ...(current.status !== next.status ? { statusFrom: current.status, statusTo: next.status } : {}),
    summary: `updated ${id}`,
  });
  return buildSuccessOutput({
    now,
    action: 'update',
    projectPath,
    item: next,
    items: [next],
    planEvent: updateEvent,
    content: `Updated plan item ${id}`,
    explanation: input.explanation,
  });
}

function handleClaim(
  input: UpdatePlanV2Input,
  context: ToolExecutionContext,
  projectPath: string,
  projectStore: Map<string, PlanItemV2>,
  now: string,
): UpdatePlanOutput {
  const id = readNonEmptyString(input.id);
  if (!id) return buildMissingId('claim', projectPath, now);
  const current = projectStore.get(id);
  if (!current) return buildNotFound('claim', projectPath, id, now);
  if (!checkExpectedRevision(input.expectedRevision, current.revision)) {
    return buildRevisionConflict('claim', projectPath, id, current.revision, now);
  }
  const actorRole = resolveActorRole(context.agentId);
  const requestedAssignee = readNonEmptyString(input.assigneeWorkerId);
  if (actorRole === 'worker' && requestedAssignee && requestedAssignee !== context.agentId) {
    return buildErrorOutput({
      now,
      action: 'claim',
      projectPath,
      code: 'permission_denied',
      message: 'worker can only claim item to self',
    });
  }
  if (actorRole === 'worker') {
    const currentOwner = readNonEmptyString(current.assigneeWorkerId) || 'unassigned';
    const hasOwner = currentOwner !== 'unassigned';
    if (hasOwner && currentOwner !== context.agentId) {
      return buildErrorOutput({
        now,
        action: 'claim',
        projectPath,
        code: 'permission_denied',
        message: `owner already claimed by ${currentOwner}; non-owner cannot claim`,
      });
    }
  }

  const next: PlanItemV2 = {
    ...current,
    assigneeWorkerId: input.assigneeWorkerId || context.agentId || current.assigneeWorkerId,
    status: current.status === 'open' ? 'in_progress' : current.status,
    updatedAt: now,
    revision: current.revision + 1,
  };
  if (next.status === 'in_progress') {
    const blockers = resolveUnmetBlockers(next, projectStore);
    if (blockers.length > 0) {
      return buildErrorOutput({
        now,
        action: 'claim',
        projectPath,
        code: 'invalid_transition',
        message: `blockedBy unresolved, cannot claim into in_progress: ${blockers.join(', ')}`,
      });
    }
  }
  projectStore.set(id, next);
  const claimEvent = appendPlanEvent({
    now,
    action: 'claim',
    projectPath,
    context,
    itemId: next.id,
    ...(current.status !== next.status ? { statusFrom: current.status, statusTo: next.status } : {}),
    summary: `claimed ${id}`,
  });
  return buildSuccessOutput({
    now,
    action: 'claim',
    projectPath,
    item: next,
    items: [next],
    planEvent: claimEvent,
    content: `Claimed plan item ${id}`,
  });
}

function handleReassign(
  input: UpdatePlanV2Input,
  context: ToolExecutionContext,
  projectPath: string,
  projectStore: Map<string, PlanItemV2>,
  now: string,
): UpdatePlanOutput {
  const id = readNonEmptyString(input.id);
  if (!id) return buildMissingId('reassign', projectPath, now);
  if (!input.assigneeWorkerId) {
    return buildErrorOutput({
      now,
      action: 'reassign',
      projectPath,
      code: 'validation_error',
      message: 'reassign requires assigneeWorkerId',
    });
  }
  const current = projectStore.get(id);
  if (!current) return buildNotFound('reassign', projectPath, id, now);
  if (!checkExpectedRevision(input.expectedRevision, current.revision)) {
    return buildRevisionConflict('reassign', projectPath, id, current.revision, now);
  }
  if (!canWriteItem(context, current)) {
    return buildPermissionDenied('reassign', projectPath, id, now);
  }
  const actorRole = resolveActorRole(context.agentId);
  if (actorRole === 'worker') {
    return buildErrorOutput({
      now,
      action: 'reassign',
      projectPath,
      code: 'permission_denied',
      message: 'worker cannot reassign owner; only system/reviewer can reassign',
    });
  }

  const next: PlanItemV2 = {
    ...current,
    assigneeWorkerId: input.assigneeWorkerId,
    updatedAt: now,
    revision: current.revision + 1,
  };
  projectStore.set(id, next);
  return buildSuccessOutput({
    now,
    action: 'reassign',
    projectPath,
    item: next,
    items: [next],
    content: `Reassigned plan item ${id} to ${input.assigneeWorkerId}`,
  });
}

function handleSetStatus(
  input: UpdatePlanV2Input,
  context: ToolExecutionContext,
  projectPath: string,
  projectStore: Map<string, PlanItemV2>,
  now: string,
): UpdatePlanOutput {
  const id = readNonEmptyString(input.id);
  if (!id) return buildMissingId('set_status', projectPath, now);
  const nextStatus = normalizePlanStatus(input.status);
  if (!nextStatus) {
    return buildErrorOutput({
      now,
      action: 'set_status',
      projectPath,
      code: 'validation_error',
      message: 'set_status requires valid status',
    });
  }
  const current = projectStore.get(id);
  if (!current) return buildNotFound('set_status', projectPath, id, now);
  if (!checkExpectedRevision(input.expectedRevision, current.revision)) {
    return buildRevisionConflict('set_status', projectPath, id, current.revision, now);
  }
  if (!canWriteItem(context, current)) {
    return buildPermissionDenied('set_status', projectPath, id, now);
  }
  const statusCheck = validateTransition(current.status, nextStatus);
  if (!statusCheck.ok) return buildInvalidTransition('set_status', projectPath, id, current.status, nextStatus, now);
  if (current.status === 'review_pending' && nextStatus === 'done' && current.evidence.length === 0) {
    return buildErrorOutput({
      now,
      action: 'set_status',
      projectPath,
      code: 'validation_error',
      message: 'review_pending -> done requires at least one evidence entry',
    });
  }
  if (nextStatus === 'in_progress') {
    const blockers = resolveUnmetBlockers(current, projectStore);
    if (blockers.length > 0) {
      return buildErrorOutput({
        now,
        action: 'set_status',
        projectPath,
        code: 'invalid_transition',
        message: `blockedBy unresolved, cannot set in_progress: ${blockers.join(', ')}`,
      });
    }
  }

  const next: PlanItemV2 = {
    ...current,
    status: nextStatus,
    updatedAt: now,
    revision: current.revision + 1,
  };
  projectStore.set(id, next);
  const event = appendPlanEvent({
    now,
    action: 'set_status',
    projectPath,
    context,
    itemId: next.id,
    statusFrom: current.status,
    statusTo: next.status,
    summary: `status ${current.status} -> ${next.status}`,
  });
  return buildSuccessOutput({
    now,
    action: 'set_status',
    projectPath,
    item: next,
    items: [next],
    planEvent: event,
    content: `Updated status for ${id}: ${current.status} -> ${nextStatus}`,
  });
}

function handleSetDependency(
  input: UpdatePlanV2Input,
  context: ToolExecutionContext,
  projectPath: string,
  projectStore: Map<string, PlanItemV2>,
  now: string,
): UpdatePlanOutput {
  const id = readNonEmptyString(input.id);
  if (!id) return buildMissingId('set_dependency', projectPath, now);
  const current = projectStore.get(id);
  if (!current) return buildNotFound('set_dependency', projectPath, id, now);
  if (!checkExpectedRevision(input.expectedRevision, current.revision)) {
    return buildRevisionConflict('set_dependency', projectPath, id, current.revision, now);
  }
  if (!canWriteItem(context, current)) {
    return buildPermissionDenied('set_dependency', projectPath, id, now);
  }

  const nextBlockedBy = input.blockedBy ? normalizeDependencyArray(input.blockedBy, current.blockedBy) : current.blockedBy;
  if (hasMixedNoneDependency(nextBlockedBy)) {
    return buildErrorOutput({
      now,
      action: 'set_dependency',
      projectPath,
      code: 'validation_error',
      message: 'blockedBy cannot mix "none" with concrete dependency ids',
    });
  }

  const next: PlanItemV2 = {
    ...current,
    blockedBy: nextBlockedBy,
    dependsOn: input.dependsOn ? normalizeDependencyArray(input.dependsOn, current.dependsOn) : current.dependsOn,
    updatedAt: now,
    revision: current.revision + 1,
  };
  projectStore.set(id, next);
  return buildSuccessOutput({
    now,
    action: 'set_dependency',
    projectPath,
    item: next,
    items: [next],
    content: `Updated dependencies for ${id}`,
  });
}

function handleAppendEvidence(
  input: UpdatePlanV2Input,
  context: ToolExecutionContext,
  projectPath: string,
  projectStore: Map<string, PlanItemV2>,
  now: string,
): UpdatePlanOutput {
  const id = readNonEmptyString(input.id);
  if (!id) return buildMissingId('append_evidence', projectPath, now);
  const current = projectStore.get(id);
  if (!current) return buildNotFound('append_evidence', projectPath, id, now);
  if (!checkExpectedRevision(input.expectedRevision, current.revision)) {
    return buildRevisionConflict('append_evidence', projectPath, id, current.revision, now);
  }
  if (!canWriteItem(context, current)) {
    return buildPermissionDenied('append_evidence', projectPath, id, now);
  }
  if (!input.evidence?.type || !input.evidence.content) {
    return buildErrorOutput({
      now,
      action: 'append_evidence',
      projectPath,
      code: 'validation_error',
      message: 'append_evidence requires evidence.type and evidence.content',
    });
  }
  const evidence: PlanEvidence = {
    id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: now,
    type: input.evidence.type,
    content: input.evidence.content,
    ...(input.evidence.ref ? { ref: input.evidence.ref } : {}),
  };

  const next: PlanItemV2 = {
    ...current,
    evidence: [...current.evidence, evidence],
    updatedAt: now,
    revision: current.revision + 1,
  };
  projectStore.set(id, next);
  return buildSuccessOutput({
    now,
    action: 'append_evidence',
    projectPath,
    item: next,
    items: [next],
    content: `Appended evidence to ${id}`,
  });
}

function handleClose(
  input: UpdatePlanV2Input,
  context: ToolExecutionContext,
  projectPath: string,
  projectStore: Map<string, PlanItemV2>,
  now: string,
): UpdatePlanOutput {
  const id = readNonEmptyString(input.id);
  if (!id) return buildMissingId('close', projectPath, now);
  const current = projectStore.get(id);
  if (!current) return buildNotFound('close', projectPath, id, now);
  if (!checkExpectedRevision(input.expectedRevision, current.revision)) {
    return buildRevisionConflict('close', projectPath, id, current.revision, now);
  }
  if (!canWriteItem(context, current)) {
    return buildPermissionDenied('close', projectPath, id, now);
  }
  const statusCheck = validateTransition(current.status, 'closed');
  if (!statusCheck.ok) return buildInvalidTransition('close', projectPath, id, current.status, 'closed', now);

  const next: PlanItemV2 = {
    ...current,
    status: 'closed',
    updatedAt: now,
    revision: current.revision + 1,
  };
  projectStore.set(id, next);
  const event = appendPlanEvent({
    now,
    action: 'close',
    projectPath,
    context,
    itemId: next.id,
    statusFrom: current.status,
    statusTo: next.status,
    summary: `closed ${id}`,
  });
  return buildSuccessOutput({
    now,
    action: 'close',
    projectPath,
    item: next,
    items: [next],
    planEvent: event,
    content: `Closed plan item ${id}`,
  });
}

function handleArchive(
  input: UpdatePlanV2Input,
  context: ToolExecutionContext,
  projectPath: string,
  projectStore: Map<string, PlanItemV2>,
  now: string,
): UpdatePlanOutput {
  const id = readNonEmptyString(input.id);
  if (!id) return buildMissingId('archive', projectPath, now);
  const current = projectStore.get(id);
  if (!current) return buildNotFound('archive', projectPath, id, now);
  if (!checkExpectedRevision(input.expectedRevision, current.revision)) {
    return buildRevisionConflict('archive', projectPath, id, current.revision, now);
  }
  if (!canWriteItem(context, current)) {
    return buildPermissionDenied('archive', projectPath, id, now);
  }

  const next: PlanItemV2 = {
    ...current,
    archivedAt: now,
    updatedAt: now,
    revision: current.revision + 1,
  };
  projectStore.set(id, next);
  return buildSuccessOutput({
    now,
    action: 'archive',
    projectPath,
    item: next,
    items: [next],
    content: `Archived plan item ${id}`,
  });
}

function buildMissingId(action: UpdatePlanAction, projectPath: string, now: string): UpdatePlanOutput {
  return buildErrorOutput({
    now,
    action,
    projectPath,
    code: 'validation_error',
    message: `${action} requires id`,
  });
}

function buildNotFound(action: UpdatePlanAction, projectPath: string, id: string, now: string): UpdatePlanOutput {
  return buildErrorOutput({
    now,
    action,
    projectPath,
    code: 'not_found',
    message: `plan item not found: ${id}`,
  });
}

function buildPermissionDenied(action: UpdatePlanAction, projectPath: string, id: string, now: string): UpdatePlanOutput {
  return buildErrorOutput({
    now,
    action,
    projectPath,
    code: 'permission_denied',
    message: `permission denied for plan item ${id}`,
  });
}

function buildRevisionConflict(
  action: UpdatePlanAction,
  projectPath: string,
  id: string,
  currentRevision: number,
  now: string,
): UpdatePlanOutput {
  return buildErrorOutput({
    now,
    action,
    projectPath,
    code: 'revision_conflict',
    message: `revision conflict for ${id}: current=${currentRevision}`,
  });
}

function buildInvalidTransition(
  action: UpdatePlanAction,
  projectPath: string,
  id: string,
  from: PlanStatus,
  to: PlanStatus,
  now: string,
): UpdatePlanOutput {
  return buildErrorOutput({
    now,
    action,
    projectPath,
    code: 'invalid_transition',
    message: `invalid status transition for ${id}: ${from} -> ${to}`,
  });
}

function buildErrorOutput(params: {
  now: string;
  action: UpdatePlanAction;
  projectPath: string;
  code: UpdatePlanErrorCode;
  message: string;
}): UpdatePlanOutput {
  return {
    ok: false,
    action: params.action,
    content: `update_plan ${params.action} failed: ${params.message}`,
    errorCode: params.code,
    error: params.message,
    projectPath: params.projectPath,
    updatedAt: params.now,
    plan: [],
  };
}

function buildSuccessOutput(params: {
  now: string;
  action: UpdatePlanAction;
  projectPath: string;
  item?: PlanItemV2;
  items?: PlanItemV2[];
  events?: PlanEvent[];
  planEvent?: PlanEvent;
  content: string;
  explanation?: string;
}): UpdatePlanOutput {
  const items = params.items ?? (params.item ? [params.item] : []);
  const legacyPlan = toLegacyPlan(items);
  return {
    ok: true,
    content: params.content,
    explanation: params.explanation,
    plan: legacyPlan,
    updatedAt: params.now,
    action: params.action,
    projectPath: params.projectPath,
    ...(params.item ? { item: deepClone(params.item) } : {}),
    ...(params.items ? { items: deepClone(params.items) } : {}),
    ...(params.events ? { events: deepClone(params.events) } : {}),
    ...(params.planEvent ? { planEvent: deepClone(params.planEvent) } : {}),
  };
}

function resolveProjectPath(inputProjectPath: string | undefined, cwd: string): string {
  const raw = inputProjectPath?.trim() || cwd.trim() || process.cwd();
  return path.resolve(raw);
}

function ensureProjectStore(projectPath: string): Map<string, PlanItemV2> {
  let scoped = store.byProjectPath.get(projectPath);
  if (!scoped) {
    scoped = new Map();
    store.byProjectPath.set(projectPath, scoped);
  }
  return scoped;
}

function ensureProjectEventStore(projectPath: string): PlanEvent[] {
  let scoped = store.eventsByProjectPath.get(projectPath);
  if (!scoped) {
    scoped = [];
    store.eventsByProjectPath.set(projectPath, scoped);
  }
  return scoped;
}

function hasScopeAccess(projectPath: string, context: ToolExecutionContext, actorRole: ActorRole): boolean {
  if (actorRole === 'system') return true;
  const cwd = path.resolve(context.cwd || process.cwd());
  const scopedProject = path.resolve(projectPath);
  return scopedProject === cwd;
}

function canWriteItem(context: ToolExecutionContext, item: PlanItemV2): boolean {
  const agentId = (context.agentId || '').trim();
  const actorRole = resolveActorRole(agentId);
  if (actorRole === 'system') return true;
  if (actorRole === 'reviewer') return true;
  return item.assigneeWorkerId === agentId;
}

function checkExpectedRevision(expectedRevision: number | undefined, currentRevision: number): boolean {
  if (!Number.isFinite(expectedRevision)) return false;
  return Math.floor(expectedRevision as number) === currentRevision;
}

function validateTransition(from: PlanStatus, to: PlanStatus): { ok: true } | { ok: false } {
  if (from === to) return { ok: true };
  const allowed = STATUS_TRANSITIONS[from] ?? [];
  if (allowed.includes(to)) return { ok: true };
  return { ok: false };
}

function sortItems(items: PlanItemV2[]): PlanItemV2[] {
  return [...items]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map((item) => deepClone(item));
}

function toLegacyPlan(items: PlanItemV2[]): LegacyPlanItem[] {
  if (items.length === 0) return [];
  return items.map((item) => ({
    step: item.title,
    status: mapPlanStatusToLegacy(item.status),
  }));
}

function mapPlanStatusToLegacy(status: PlanStatus): LegacyPlanStepStatus {
  if (status === 'in_progress' || status === 'review_pending') return 'in_progress';
  if (status === 'done' || status === 'closed') return 'completed';
  return 'pending';
}

function normalizePlanType(value: unknown): PlanType | null {
  const normalized = readNonEmptyString(value)?.toLowerCase();
  if (!normalized) return null;
  if (normalized === 'epic' || normalized === 'task' || normalized === 'subtask' || normalized === 'review') return normalized;
  return null;
}

function normalizePlanPriority(value: unknown): PlanPriority | null {
  const normalized = readNonEmptyString(value)?.toUpperCase();
  if (!normalized) return null;
  if (normalized === 'P0' || normalized === 'P1' || normalized === 'P2' || normalized === 'P3') return normalized;
  return null;
}

function normalizePlanStatus(value: unknown): PlanStatus | null {
  const normalized = readNonEmptyString(value)?.toLowerCase();
  if (!normalized) return null;
  const map: Record<string, PlanStatus> = {
    open: 'open',
    pending: 'open',
    todo: 'open',
    in_progress: 'in_progress',
    'in-progress': 'in_progress',
    inprogress: 'in_progress',
    blocked: 'blocked',
    review_pending: 'review_pending',
    'review-pending': 'review_pending',
    reviewpending: 'review_pending',
    done: 'done',
    completed: 'done',
    close: 'closed',
    closed: 'closed',
  };
  return map[normalized] ?? null;
}

function normalizeLegacyStepStatus(value: unknown): LegacyPlanStepStatus | null {
  if (value === 'pending' || value === 'in_progress' || value === 'completed') return value;
  const normalized = readNonEmptyString(value)?.toLowerCase();
  if (!normalized) return null;
  const map: Record<string, LegacyPlanStepStatus> = {
    todo: 'pending',
    doing: 'in_progress',
    done: 'completed',
    inprogress: 'in_progress',
    'in-progress': 'in_progress',
    pending: 'pending',
    completed: 'completed',
    'in_progress': 'in_progress',
  };
  return map[normalized] ?? null;
}

function normalizeDependencyArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const normalized = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  if (normalized.length === 0) return [...fallback];
  return Array.from(new Set(normalized));
}

function hasMixedNoneDependency(values: string[]): boolean {
  if (values.length <= 1) return false;
  return values.some((value) => value.toLowerCase() === 'none');
}

function resolveUnmetBlockers(item: PlanItemV2, scopedStore: Map<string, PlanItemV2>): string[] {
  const blockers = normalizeDependencyArray(item.blockedBy, ['none'])
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (blockers.length === 0 || (blockers.length === 1 && blockers[0].toLowerCase() === 'none')) {
    return [];
  }
  const unresolved: string[] = [];
  for (const blockerId of blockers) {
    if (blockerId.toLowerCase() === 'none') continue;
    const blocker = scopedStore.get(blockerId);
    if (!blocker || blocker.status !== 'closed') unresolved.push(blockerId);
  }
  return unresolved;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function generatePlanId(): string {
  return `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeComparableText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function isUpdatePlanAction(value: string): value is UpdatePlanAction {
  return value === 'create'
    || value === 'update'
    || value === 'list'
    || value === 'search'
    || value === 'claim'
    || value === 'reassign'
    || value === 'set_status'
    || value === 'set_dependency'
    || value === 'append_evidence'
    || value === 'close'
    || value === 'archive';
}

function listAllItems(): PlanItemV2[] {
  const rows: PlanItemV2[] = [];
  for (const scoped of store.byProjectPath.values()) {
    for (const item of scoped.values()) rows.push(item);
  }
  return rows;
}

function listAllEvents(): PlanEvent[] {
  const rows: PlanEvent[] = [];
  for (const scoped of store.eventsByProjectPath.values()) {
    rows.push(...scoped);
  }
  return rows.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

function filterReadableItems(items: PlanItemV2[], actorRole: ActorRole): PlanItemV2[] {
  if (actorRole === 'system') return items;
  return items.filter((item) => item.status !== 'closed' && !item.archivedAt);
}

type ActorRole = 'system' | 'reviewer' | 'worker';

function resolveActorRole(agentId: string | undefined): ActorRole {
  const normalized = (agentId || '').trim().toLowerCase();
  if (!normalized || normalized === 'finger-system-agent') return 'system';
  if (normalized.includes('reviewer')) return 'reviewer';
  return 'worker';
}

function appendPlanEvent(params: {
  now: string;
  action: UpdatePlanAction;
  projectPath: string;
  context: ToolExecutionContext;
  itemId?: string;
  statusFrom?: PlanStatus;
  statusTo?: PlanStatus;
  summary: string;
}): PlanEvent {
  const event: PlanEvent = {
    id: `pe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: params.now,
    action: params.action,
    projectPath: params.projectPath,
    summary: params.summary,
    ...(params.itemId ? { itemId: params.itemId } : {}),
    ...(params.context.agentId ? { actorAgentId: params.context.agentId } : {}),
    ...(params.statusFrom ? { statusFrom: params.statusFrom } : {}),
    ...(params.statusTo ? { statusTo: params.statusTo } : {}),
  };
  const scoped = ensureProjectEventStore(params.projectPath);
  scoped.push(event);
  if (scoped.length > 500) {
    scoped.splice(0, scoped.length - 500);
  }
  return event;
}

function isWriteV2Action(action: UpdatePlanAction): boolean {
  return action === 'create'
    || action === 'update'
    || action === 'claim'
    || action === 'reassign'
    || action === 'set_status'
    || action === 'set_dependency'
    || action === 'append_evidence'
    || action === 'close'
    || action === 'archive';
}

function ensureStoreLoaded(): void {
  if (storeLoaded) return;
  storeLoaded = true;
  const storeFile = resolveUpdatePlanStoreFile();
  try {
    if (!existsSync(storeFile)) return;
    const raw = readFileSync(storeFile, 'utf-8');
    if (!raw || raw.trim().length === 0) return;
    const parsed = JSON.parse(raw) as {
      version?: number;
      projects?: Array<{
        projectPath?: string;
        items?: PlanItemV2[];
        events?: PlanEvent[];
      }>;
    };
    if (!Array.isArray(parsed.projects)) return;

    for (const project of parsed.projects) {
      const projectPath = typeof project.projectPath === 'string' ? project.projectPath.trim() : '';
      if (!projectPath) continue;
      const scopedItems = new Map<string, PlanItemV2>();
      for (const item of Array.isArray(project.items) ? project.items : []) {
        if (!item || typeof item.id !== 'string' || item.id.trim().length === 0) continue;
        scopedItems.set(item.id, deepClone(item));
      }
      if (scopedItems.size > 0) {
        store.byProjectPath.set(projectPath, scopedItems);
      }
      const scopedEvents = (Array.isArray(project.events) ? project.events : [])
        .filter((event) => event && typeof event.id === 'string' && event.id.trim().length > 0)
        .map((event) => deepClone(event));
      if (scopedEvents.length > 0) {
        store.eventsByProjectPath.set(projectPath, scopedEvents);
      }
    }
  } catch (error) {
    logger.module('update-plan').warn('[update_plan] Failed to load persisted plan store', {
      file: storeFile,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function persistStore(): void {
  const storeFile = resolveUpdatePlanStoreFile();
  try {
    const projects = Array.from(store.byProjectPath.entries()).map(([projectPath, scopedItems]) => ({
      projectPath,
      items: Array.from(scopedItems.values()).map((item) => deepClone(item)),
      events: (store.eventsByProjectPath.get(projectPath) ?? []).map((event) => deepClone(event)),
    }));
    const payload = {
      version: UPDATE_PLAN_STORE_VERSION,
      updatedAt: new Date().toISOString(),
      projects,
    };
    mkdirSync(path.dirname(storeFile), { recursive: true });
    const tmpPath = `${storeFile}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    renameSync(tmpPath, storeFile);
  } catch (error) {
    logger.module('update-plan').warn('[update_plan] Failed to persist plan store', {
      file: storeFile,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function cloneOutput(value: UpdatePlanOutput): UpdatePlanOutput {
  return deepClone(value);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}
