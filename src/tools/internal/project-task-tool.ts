import type { ToolRegistry } from '../../runtime/tool-registry.js';
import type { AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';
import { FINGER_PROJECT_AGENT_ID, FINGER_SYSTEM_AGENT_ID } from '../../agents/finger-general/finger-general-module.js';
import { listReviewRoutes, getReviewRoute, getReviewRouteByTaskName } from '../../agents/finger-system-agent/review-route-registry.js';
import { getExecutionLifecycleState } from '../../server/modules/execution-lifecycle.js';
import {
  parseProjectTaskState,
  mergeProjectTaskState,
  parseDelegatedProjectTaskRegistry,
  upsertDelegatedProjectTaskRegistry,
} from '../../common/project-task-state.js';

type ProjectTaskAction = 'status' | 'update';

interface ProjectTaskToolInput {
  action: ProjectTaskAction;
  session_id?: string;
  project_agent_id?: string;
  task_id?: string;
  task_name?: string;
  update_prompt?: string;
  force?: boolean;
}

interface ProjectTaskToolOutput {
  ok: boolean;
  action: ProjectTaskAction;
  busy?: boolean;
  status?: string;
  taskId?: string;
  taskName?: string;
  dispatchId?: string;
  summary?: string;
  error?: string;
  lifecycle?: {
    stage: string;
    substage?: string;
    finishReason?: string;
    dispatchId?: string;
    turnId?: string;
    lastTransitionAt?: string;
  };
  review?: {
    required: boolean;
    hasOpenRoute: boolean;
    routeTaskId?: string;
    routeTaskName?: string;
  };
  taskState?: {
    active: boolean;
    status: string;
    sourceAgentId: string;
    targetAgentId: string;
    updatedAt: string;
    taskId?: string;
    taskName?: string;
    dispatchId?: string;
    note?: string;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveProjectAgentState(
  runtimeView: unknown,
  agentId: string,
): {
  busy: boolean;
  status?: string;
  dispatchId?: string;
  taskId?: string;
  summary?: string;
} {
  const view = asRecord(runtimeView);
  const agents = Array.isArray(view.agents) ? view.agents : [];
  const hit = agents.find((item) => {
    const record = asRecord(item);
    return asTrimmedString(record.id) === agentId;
  });
  const target = asRecord(hit);
  const status = asTrimmedString(target.status).toLowerCase();
  const lastEvent = asRecord(target.lastEvent);
  const taskId = asTrimmedString(lastEvent.taskId);
  const dispatchId = asTrimmedString(lastEvent.dispatchId);
  const summary = asTrimmedString(lastEvent.summary);
  const busy = status === 'running' || status === 'queued' || status === 'waiting_input' || status === 'paused';
  return {
    busy,
    ...(status ? { status } : {}),
    ...(dispatchId ? { dispatchId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(summary ? { summary } : {}),
  };
}

function resolveTaskRoute(taskId: string, taskName: string) {
  if (taskId) return getReviewRoute(taskId) ?? (taskName ? getReviewRouteByTaskName(taskName) : undefined);
  if (taskName) return getReviewRouteByTaskName(taskName);
  return undefined;
}

function buildLifecycleSnapshot(deps: AgentRuntimeDeps, sessionId: string) {
  const lifecycle = getExecutionLifecycleState(deps.sessionManager, sessionId);
  if (!lifecycle) return undefined;
  return {
    stage: lifecycle.stage,
    ...(lifecycle.substage ? { substage: lifecycle.substage } : {}),
    ...(lifecycle.finishReason ? { finishReason: lifecycle.finishReason } : {}),
    ...(lifecycle.dispatchId ? { dispatchId: lifecycle.dispatchId } : {}),
    ...(lifecycle.turnId ? { turnId: lifecycle.turnId } : {}),
    ...(lifecycle.lastTransitionAt ? { lastTransitionAt: lifecycle.lastTransitionAt } : {}),
  };
}

function resolveSessionProjectTaskState(deps: AgentRuntimeDeps, sessionId: string) {
  if (!sessionId) return null;
  const session = deps.sessionManager.getSession(sessionId);
  if (!session) return null;
  return parseProjectTaskState(session.context?.projectTaskState);
}

function isProjectExecutingLifecycle(stage: string | undefined): boolean {
  const normalized = asTrimmedString(stage).toLowerCase();
  return normalized === 'running'
    || normalized === 'dispatching'
    || normalized === 'waiting_model'
    || normalized === 'retrying';
}

function maybePromoteDispatchedToInProgress(
  deps: AgentRuntimeDeps,
  sessionId: string,
  lifecycleStage: string | undefined,
  agentBusy: boolean,
): ReturnType<typeof parseProjectTaskState> {
  const session = deps.sessionManager.getSession(sessionId);
  if (!session) return null;
  const current = parseProjectTaskState(session.context?.projectTaskState);
  if (!current) return null;
  if (!current.active || (current.status !== 'dispatched' && current.status !== 'accepted')) return current;
  if (!agentBusy && !isProjectExecutingLifecycle(lifecycleStage)) return current;

  const nextStatus = current.status === 'dispatched' ? 'accepted' : 'in_progress';
  const nextNote = current.status === 'dispatched'
    ? 'project_dispatch_accepted'
    : 'project_started_execution';
  const next = mergeProjectTaskState(current, {
    status: nextStatus,
    note: nextNote,
  });
  const registry = upsertDelegatedProjectTaskRegistry(
    parseDelegatedProjectTaskRegistry(session.context?.projectTaskRegistry),
    {
      sourceAgentId: next.sourceAgentId,
      targetAgentId: next.targetAgentId,
      taskId: next.taskId,
      taskName: next.taskName,
      status: next.status,
      active: next.active,
      dispatchId: next.dispatchId,
      summary: next.summary,
      note: next.note,
    },
  );
  deps.sessionManager.updateContext(sessionId, {
    projectTaskState: next,
    projectTaskRegistry: registry,
  });
  return next;
}

export function registerProjectTaskTool(
  toolRegistry: ToolRegistry,
  getAgentRuntimeDeps: () => AgentRuntimeDeps,
): void {
  toolRegistry.register({
    name: 'project.task.status',
    description: 'Read current project-agent execution status, lifecycle, and review-route contract before dispatch/update.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status'] },
        session_id: { type: 'string' },
        project_agent_id: { type: 'string' },
        task_id: { type: 'string' },
        task_name: { type: 'string' },
      },
      required: ['action'],
    },
    policy: 'allow',
    handler: async (input: unknown): Promise<ProjectTaskToolOutput> => {
      const deps = getAgentRuntimeDeps();
      const params = asRecord(input);
      const action = asTrimmedString(params.action) as ProjectTaskAction;
      const projectAgentId = asTrimmedString(params.project_agent_id) || FINGER_PROJECT_AGENT_ID;
      const taskId = asTrimmedString(params.task_id);
      const taskName = asTrimmedString(params.task_name);
      const sessionId = asTrimmedString(params.session_id);
      if (action !== 'status') {
        return {
          ok: false,
          action: 'status',
          error: 'Unsupported action for project.task.status',
        };
      }
      const runtimeView = await deps.agentRuntimeBlock.execute('runtime_view', {});
      const agentState = resolveProjectAgentState(runtimeView, projectAgentId);
      const route = resolveTaskRoute(taskId, taskName);
      const lifecycle = sessionId ? buildLifecycleSnapshot(deps, sessionId) : undefined;
      const sessionTaskState = sessionId
        ? maybePromoteDispatchedToInProgress(deps, sessionId, lifecycle?.stage, agentState.busy)
        : null;
      const effectiveStatus = asTrimmedString(sessionTaskState?.status) || agentState.status;
      const effectiveTaskId = asTrimmedString(sessionTaskState?.taskId) || agentState.taskId || taskId;
      const effectiveTaskName = asTrimmedString(sessionTaskState?.taskName) || taskName;
      const effectiveDispatchId = asTrimmedString(sessionTaskState?.dispatchId) || agentState.dispatchId;
      return {
        ok: true,
        action: 'status',
        busy: agentState.busy,
        ...(effectiveStatus ? { status: effectiveStatus } : {}),
        ...(effectiveTaskId ? { taskId: effectiveTaskId } : {}),
        ...(effectiveTaskName ? { taskName: effectiveTaskName } : {}),
        ...(effectiveDispatchId ? { dispatchId: effectiveDispatchId } : {}),
        ...(agentState.summary ? { summary: agentState.summary } : {}),
        ...(lifecycle ? { lifecycle } : {}),
        ...(sessionTaskState ? {
          taskState: {
            active: sessionTaskState.active,
            status: sessionTaskState.status,
            sourceAgentId: sessionTaskState.sourceAgentId,
            targetAgentId: sessionTaskState.targetAgentId,
            updatedAt: sessionTaskState.updatedAt,
            ...(sessionTaskState.taskId ? { taskId: sessionTaskState.taskId } : {}),
            ...(sessionTaskState.taskName ? { taskName: sessionTaskState.taskName } : {}),
            ...(sessionTaskState.dispatchId ? { dispatchId: sessionTaskState.dispatchId } : {}),
            ...(sessionTaskState.note ? { note: sessionTaskState.note } : {}),
          },
        } : {}),
        review: {
          required: route?.reviewRequired === true,
          hasOpenRoute: !!route,
          ...(route?.taskId ? { routeTaskId: route.taskId } : {}),
          ...(route?.taskName ? { routeTaskName: route.taskName } : {}),
        },
      };
    },
  });

  toolRegistry.register({
    name: 'project.task.update',
    description: 'Update current in-flight project task (same task identity) instead of creating unrelated new dispatch.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['update'] },
        session_id: { type: 'string' },
        task_id: { type: 'string' },
        task_name: { type: 'string' },
        update_prompt: { type: 'string' },
        force: { type: 'boolean' },
      },
      required: ['action', 'session_id', 'update_prompt'],
    },
    policy: 'allow',
    handler: async (input: unknown): Promise<ProjectTaskToolOutput> => {
      const deps = getAgentRuntimeDeps();
      const params = asRecord(input);
      const action = asTrimmedString(params.action) as ProjectTaskAction;
      if (action !== 'update') {
        return {
          ok: false,
          action: 'update',
          error: 'Unsupported action for project.task.update',
        };
      }
      const sessionId = asTrimmedString(params.session_id);
      const updatePrompt = asTrimmedString(params.update_prompt);
      const taskId = asTrimmedString(params.task_id);
      const taskName = asTrimmedString(params.task_name);
      const force = params.force === true;
      if (!sessionId) {
        return { ok: false, action: 'update', error: 'session_id is required' };
      }
      if (!updatePrompt) {
        return { ok: false, action: 'update', error: 'update_prompt is required' };
      }
      const route = resolveTaskRoute(taskId, taskName);
      const runtimeView = await deps.agentRuntimeBlock.execute('runtime_view', {});
      const agentState = resolveProjectAgentState(runtimeView, FINGER_PROJECT_AGENT_ID);
      const allowWhileBusy = force || agentState.busy;
      const assignment: Record<string, unknown> = {
        ...(taskId ? { task_id: taskId } : route?.taskId ? { task_id: route.taskId } : {}),
        ...(taskName ? { task_name: taskName } : route?.taskName ? { task_name: route.taskName } : {}),
      };
      if (route?.reviewRequired) {
        assignment.review_required = true;
        if (typeof route.acceptanceCriteria === 'string' && route.acceptanceCriteria.trim().length > 0) {
          assignment.acceptance_criteria = route.acceptanceCriteria;
        }
      }

      const dispatch = await deps.agentRuntimeBlock.execute('dispatch', {
        sourceAgentId: FINGER_SYSTEM_AGENT_ID,
        targetAgentId: FINGER_PROJECT_AGENT_ID,
        task: {
          prompt: updatePrompt,
          ...(Object.keys(assignment).length > 0 ? {
            metadata: {
              taskUpdate: true,
            },
          } : {}),
        },
        sessionId,
        assignment,
        metadata: {
          source: 'project-task-update',
          role: 'system',
          allowDispatchWhileBusy: allowWhileBusy,
          projectTaskUpdate: true,
          userRequestedUpdate: true,
          ...(taskId ? { taskId } : {}),
          ...(taskName ? { taskName } : {}),
        },
        queueOnBusy: true,
        maxQueueWaitMs: 0,
        blocking: false,
      } as Record<string, unknown>) as {
        ok?: boolean;
        status?: string;
        dispatchId?: string;
        error?: string;
      };

      if (!dispatch?.ok || dispatch.status === 'failed') {
        return {
          ok: false,
          action: 'update',
          ...(dispatch?.status ? { status: dispatch.status } : {}),
          ...(dispatch?.dispatchId ? { dispatchId: dispatch.dispatchId } : {}),
          error: dispatch?.error ?? 'failed to dispatch project task update',
        };
      }

      return {
        ok: true,
        action: 'update',
        busy: agentState.busy,
        ...(agentState.status ? { status: agentState.status } : {}),
        ...(taskId ? { taskId } : route?.taskId ? { taskId: route.taskId } : {}),
        ...(taskName ? { taskName } : route?.taskName ? { taskName: route.taskName } : {}),
        ...(dispatch.dispatchId ? { dispatchId: dispatch.dispatchId } : {}),
        ...(dispatch.status ? { status: dispatch.status } : {}),
        summary: 'project task update dispatched',
        review: {
          required: route?.reviewRequired === true,
          hasOpenRoute: !!route,
          ...(route?.taskId ? { routeTaskId: route.taskId } : {}),
          ...(route?.taskName ? { routeTaskName: route.taskName } : {}),
        },
      };
    },
  });
}

export function listOpenProjectReviewRoutes(): Array<{
  taskId: string;
  taskName?: string;
  projectId?: string;
  updatedAt: number;
}> {
  return listReviewRoutes().map((route) => ({
    taskId: route.taskId,
    ...(route.taskName ? { taskName: route.taskName } : {}),
    ...(route.projectId ? { projectId: route.projectId } : {}),
    updatedAt: route.updatedAt,
  }));
}
