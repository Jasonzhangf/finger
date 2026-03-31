/**
 * Report Task Completion Tool
 *
 * Project Agent 报告任务完成，附交付标的。
 * 默认先路由到 reviewer；reviewer 通过后再上报给 system。
 */

import type { ToolRegistry } from '../../runtime/tool-registry.js';
import { writeFileSync } from 'fs';
import type { AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';
import { dispatchTaskToSystemAgent } from '../../agents/finger-system-agent/task-report-dispatcher.js';
import { emitTaskCompleted } from '../../agents/finger-system-agent/system-events.js';
import {
  buildTaskReportContract,
  resolveStructuredDeliveryClaim,
  type TaskReportContract,
} from '../../common/task-report-contract.js';
import {
  getReviewRoute,
  getReviewRouteByTaskName,
  removeReviewRoute,
} from '../../agents/finger-system-agent/review-route-registry.js';
import {
  parseDelegatedProjectTaskRegistry,
  mergeProjectTaskState,
  parseProjectTaskState,
  PROJECT_AGENT_ID,
  SYSTEM_AGENT_ID,
  upsertDelegatedProjectTaskRegistry,
} from '../../common/project-task-state.js';

export interface ReportTaskCompletionInput {
  action: 'report';
  taskId: string;
  taskName?: string;
  taskSummary: string;
  sessionId: string;
  result: 'success' | 'failure';
  projectId: string;
  /** 交付标的：截图路径、执行结果、关键变更文件列表等 */
  deliveryArtifacts?: string;
  /** structured status for deterministic routing */
  status?: string;
  /** structured next action for deterministic routing */
  nextAction?: string;
  /** explicit delivery claim; overrides legacy text heuristics */
  deliveryClaim?: boolean;
  /** evidence lines / artifacts */
  evidence?: string[] | string;
}

export interface ReportTaskCompletionOutput {
  ok: boolean;
  action: string;
  dispatchId?: string;
  status?: 'queued' | 'completed' | 'failed';
  error?: string;
}

const INCOMPLETE_MARKERS = [
  'wip',
  'in progress',
  '进行中',
  '未完成',
  '继续',
  'todo',
  'blocked',
  'pending',
  '待完成',
];

const CLAIM_MARKERS = [
  'delivery',
  'delivered',
  'completed',
  'done',
  '已完成',
  '交付',
  '完成了',
  '验收',
  'acceptance',
  'pass',
];

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function hasDeliveryClaim(summary: string, artifacts: string, result: 'success' | 'failure'): boolean {
  if (result !== 'success') return false;
  const summaryLc = summary.toLowerCase();
  const artifactsLc = artifacts.toLowerCase();
  if (!summaryLc && !artifactsLc) return false;
  if (INCOMPLETE_MARKERS.some((marker) => summaryLc.includes(marker) || artifactsLc.includes(marker))) return false;
  if (artifacts.length > 0) return true;
  return CLAIM_MARKERS.some((marker) => summaryLc.includes(marker));
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return undefined;
}

function resolveEvidence(raw: Record<string, unknown>, params: ReportTaskCompletionInput): string[] | string | undefined {
  if (Array.isArray(params.evidence) || typeof params.evidence === 'string') return params.evidence;
  if (Array.isArray(raw.evidence)) return raw.evidence as string[];
  if (typeof raw.evidence === 'string') return raw.evidence.trim();
  if (typeof raw.evidence_items === 'string') return raw.evidence_items.trim();
  if (Array.isArray(raw.evidence_items)) return raw.evidence_items as string[];
  return undefined;
}

function updateProjectTaskStateForSession(
  deps: AgentRuntimeDeps,
  sessionId: string | undefined,
  patch: {
    active?: boolean;
    status?: 'dispatched' | 'in_progress' | 'waiting_review' | 'pending_approval' | 'completed' | 'failed' | 'cancelled';
    taskId?: string;
    taskName?: string;
    dispatchId?: string;
    summary?: string;
    note?: string;
  },
): void {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) return;
  const session = deps.sessionManager.getSession(normalizedSessionId);
  if (!session) return;
  const current = parseProjectTaskState(session.context?.projectTaskState);
  const next = mergeProjectTaskState(current, {
    ...patch,
    sourceAgentId: current?.sourceAgentId ?? SYSTEM_AGENT_ID,
    targetAgentId: current?.targetAgentId ?? PROJECT_AGENT_ID,
  });
  const currentRegistry = parseDelegatedProjectTaskRegistry(session.context?.projectTaskRegistry);
  const nextRegistry = upsertDelegatedProjectTaskRegistry(currentRegistry, {
    sourceAgentId: next.sourceAgentId,
    targetAgentId: next.targetAgentId,
    taskId: next.taskId,
    taskName: next.taskName,
    status: next.status,
    active: next.active,
    dispatchId: next.dispatchId,
    summary: next.summary,
    note: next.note,
  });
  deps.sessionManager.updateContext(normalizedSessionId, {
    projectTaskState: next,
    projectTaskRegistry: nextRegistry,
  });
  writeTaskRouterMarkdown(session.projectPath, next, nextRegistry);
}

function writeTaskRouterMarkdown(
  projectPath: string,
  state: ReturnType<typeof mergeProjectTaskState>,
  registry: ReturnType<typeof upsertDelegatedProjectTaskRegistry>,
): void {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) return;
  const normalized = projectPath.replace(/\/+$/, '');
  const taskFilePath = `${normalized}/TASK.md`;
  const lines: string[] = [
    '# TASK Router',
    '',
    `Updated: ${new Date().toISOString()}`,
    '',
    '## Current Task State',
    `- active: ${state.active}`,
    `- status: ${state.status}`,
    `- source: ${state.sourceAgentId}`,
    `- target: ${state.targetAgentId}`,
    state.taskId ? `- taskId: ${state.taskId}` : '- taskId: N/A',
    state.taskName ? `- taskName: ${state.taskName}` : '- taskName: N/A',
    state.dispatchId ? `- dispatchId: ${state.dispatchId}` : '- dispatchId: N/A',
    state.note ? `- note: ${state.note}` : '- note: N/A',
    '',
    '## Delegated Project List (latest)',
  ];
  const ordered = [...registry]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 20);
  if (ordered.length === 0) {
    lines.push('- (empty)');
  } else {
    for (const item of ordered) {
      lines.push(
        `- [${item.status}] active=${item.active} target=${item.targetAgentId}`
        + `${item.taskId ? ` taskId=${item.taskId}` : ''}`
        + `${item.taskName ? ` task="${item.taskName}"` : ''}`
        + `${item.dispatchId ? ` dispatch=${item.dispatchId}` : ''}`
        + ` updated=${item.updatedAt}`,
      );
    }
  }
  lines.push('');
  lines.push('## Routing Rule');
  lines.push('- Context exposes concise status only.');
  lines.push('- Full task details and progression should be maintained in this TASK.md.');
  try {
    writeFileSync(taskFilePath, lines.join('\n') + '\n', 'utf8');
  } catch {
    // Best effort.
  }
}

export function registerReportTaskCompletionTool(
  toolRegistry: ToolRegistry,
  getAgentRuntimeDeps: () => AgentRuntimeDeps
): void {
  toolRegistry.register({
    name: 'report-task-completion',
    description: 'Project/Reviewer 报告任务结果，支持 review pipeline',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['report'] },
        taskId: { type: 'string' },
        taskName: { type: 'string' },
        taskSummary: { type: 'string' },
        sessionId: { type: 'string' },
        result: { type: 'string', enum: ['success', 'failure'] },
        projectId: { type: 'string' },
        delivery_artifacts: {
          type: 'string',
          description: '交付标的描述：截图路径、执行结果、关键变更文件列表等',
        },
        status: {
          type: 'string',
          description: 'Structured task status (in_progress/review_ready/completed/failed/blocked/needs_rework)',
        },
        next_action: {
          type: 'string',
          description: 'Structured next action (continue/review/approve/rework/none)',
        },
        delivery_claim: {
          type: 'boolean',
          description: 'Explicit delivery claim for review pipeline routing. Preferred over text heuristics.',
        },
        evidence: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Structured evidence list or text lines.',
        },
      },
      required: ['action', 'taskId', 'taskSummary', 'sessionId', 'result', 'projectId'],
    },
    policy: 'allow',
    handler: async (input: unknown, context?: Record<string, unknown>): Promise<ReportTaskCompletionOutput> => {
      const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
      const params = input as ReportTaskCompletionInput;
      if (params.action !== 'report') {
        return { ok: false, action: params.action, error: 'Unsupported action' };
      }

      try {
        const deps = getAgentRuntimeDeps();
        const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
        const taskName = typeof params.taskName === 'string'
          ? params.taskName.trim()
          : typeof raw.task_name === 'string'
            ? raw.task_name.trim()
            : '';
        if (!taskId && !taskName) {
          return { ok: false, action: 'report', error: 'taskId or taskName is required' };
        }
        const deliveryArtifacts = typeof params.deliveryArtifacts === 'string'
          ? params.deliveryArtifacts.trim()
          : typeof raw.delivery_artifacts === 'string'
            ? raw.delivery_artifacts.trim()
            : '';
        const structuredStatus = typeof params.status === 'string'
          ? params.status.trim()
          : typeof raw.status === 'string'
            ? raw.status.trim()
            : typeof raw.task_status === 'string'
              ? raw.task_status.trim()
              : '';
        const nextAction = typeof params.nextAction === 'string'
          ? params.nextAction.trim()
          : typeof raw.next_action === 'string'
            ? raw.next_action.trim()
            : typeof raw.nextAction === 'string'
              ? raw.nextAction.trim()
              : '';
        const deliveryClaim = normalizeOptionalBoolean(
          params.deliveryClaim ?? raw.delivery_claim ?? raw.deliveryClaim
        );
        const evidence = resolveEvidence(raw, params);
        const callerAgentId = typeof context?.agentId === 'string' ? context.agentId.trim() : '';
        const isReviewerCaller = callerAgentId.toLowerCase().includes('review');
        const reviewRoute = taskId
          ? getReviewRoute(taskId) ?? (taskName ? getReviewRouteByTaskName(taskName) : undefined)
          : (taskName ? getReviewRouteByTaskName(taskName) : undefined);
        const routeTaskId = typeof reviewRoute?.taskId === 'string' ? reviewRoute.taskId.trim() : '';
        const effectiveTaskId = routeTaskId || taskId;
        const routeTaskName = typeof reviewRoute?.taskName === 'string' ? reviewRoute.taskName.trim() : '';
        const effectiveTaskName = routeTaskName || taskName;
        const normalizedSummary = normalizeText(params.taskSummary);
        const taskReport: TaskReportContract = buildTaskReportContract({
          taskId: effectiveTaskId || params.taskId,
          taskName: effectiveTaskName || taskName || undefined,
          sessionId: params.sessionId,
          projectId: params.projectId,
          sourceAgentId: isReviewerCaller ? (callerAgentId || 'finger-reviewer') : 'finger-project-agent',
          result: params.result,
          summary: normalizedSummary,
          status: structuredStatus,
          deliveryArtifacts,
          evidence,
          nextAction,
          reviewDecision: typeof raw.review_decision === 'string' ? raw.review_decision : undefined,
          deliveryClaim,
        });
        const hasStructuredClaimSignal = typeof deliveryClaim === 'boolean'
          || structuredStatus.length > 0
          || nextAction.length > 0;
        const structuredClaim = hasStructuredClaimSignal
          ? resolveStructuredDeliveryClaim(taskReport)
          : undefined;
        const hasClaim = typeof structuredClaim === 'boolean'
          ? structuredClaim
          : hasDeliveryClaim(normalizedSummary, deliveryArtifacts, params.result);

        // Project -> Reviewer
        if (!isReviewerCaller && !reviewRoute) {
          return {
            ok: false,
            action: 'report',
            error: `review route missing for task ${taskId || taskName}; review pipeline is fail-closed`,
          };
        }

        if (reviewRoute?.reviewRequired && !isReviewerCaller && !hasClaim) {
          const continuePrompt = [
            '[Project Delivery Continue]',
            `任务ID: ${effectiveTaskId || params.taskId}`,
            effectiveTaskName ? `任务名: ${effectiveTaskName}` : '',
            '当前报告未形成可审查交付声明（缺少清晰完成摘要或交付标的）。',
            '请继续执行任务；仅在你明确完成交付时再调用 report-task-completion。',
            '下次上报必须包含：',
            '- 完成内容摘要（明确“完成了什么”）',
            '- 关键证据（变更文件/测试结果/产物路径）',
            '- 是否满足验收标准',
          ].filter(Boolean).join('\n');

          const continueDispatch = await deps.agentRuntimeBlock.execute('dispatch', {
            sourceAgentId: 'finger-reviewer',
            targetAgentId: 'finger-project-agent',
            task: { prompt: continuePrompt },
            sessionId: params.sessionId,
            blocking: false,
            metadata: {
              source: 'project-delivery-continue',
              role: 'system',
              taskId: effectiveTaskId || params.taskId,
              ...(effectiveTaskName ? { taskName: effectiveTaskName } : {}),
              projectId: params.projectId,
              reviewRequired: true,
              noDeliveryClaim: true,
              taskReport,
            },
            queueOnBusy: true,
            maxQueueWaitMs: 0,
          } as unknown as Record<string, unknown>) as {
            ok?: boolean;
            dispatchId?: string;
            status?: 'queued' | 'completed' | 'failed';
            error?: string;
          };

          if (!continueDispatch?.ok || continueDispatch.status === 'failed') {
            return {
              ok: false,
              action: 'continue',
              dispatchId: continueDispatch?.dispatchId,
              status: continueDispatch?.status,
              error: continueDispatch?.error ?? 'redispatch to project agent failed',
            };
          }

          updateProjectTaskStateForSession(deps, reviewRoute.projectSessionId ?? params.sessionId, {
            active: true,
            status: 'in_progress',
            taskId: effectiveTaskId || params.taskId,
            taskName: effectiveTaskName || taskName || undefined,
            dispatchId: continueDispatch.dispatchId,
            summary: 'delivery claim incomplete; continue execution required',
            note: 'project_delivery_continue',
          });
          updateProjectTaskStateForSession(deps, reviewRoute.parentSessionId, {
            active: true,
            status: 'in_progress',
            taskId: effectiveTaskId || params.taskId,
            taskName: effectiveTaskName || taskName || undefined,
            dispatchId: continueDispatch.dispatchId,
            summary: 'delivery claim incomplete; waiting project re-delivery',
            note: 'project_delivery_continue',
          });

          return {
            ok: true,
            action: 'continue',
            dispatchId: continueDispatch.dispatchId,
            status: continueDispatch.status,
          };
        }

        if (reviewRoute?.reviewRequired && !isReviewerCaller) {
          const reviewPrompt = [
            '[Project Delivery for Review]',
            `任务ID: ${effectiveTaskId || 'N/A'}`,
            effectiveTaskName ? `任务名: ${effectiveTaskName}` : '',
            `任务摘要: ${normalizedSummary}`,
            `结果: ${params.result}`,
            `项目: ${params.projectId}`,
            reviewRoute.acceptanceCriteria ? `验收标准: ${reviewRoute.acceptanceCriteria}` : '',
            deliveryArtifacts ? `交付标的: ${deliveryArtifacts}` : '',
            '',
            '请 review agent 执行审查：',
            '- 通过：调用 report-task-completion 上报 system agent',
            '- 拒绝：调用 agent.dispatch 把拒绝意见发回 project agent',
          ].filter(Boolean).join('\n');

          const reviewDispatch = await deps.agentRuntimeBlock.execute('dispatch', {
            sourceAgentId: 'finger-project-agent',
            targetAgentId: reviewRoute.reviewAgentId,
            task: { prompt: reviewPrompt },
            sessionId: params.sessionId,
            blocking: false,
            metadata: {
              source: 'project-delivery-report',
              role: 'system',
              taskId: effectiveTaskId || params.taskId,
              ...(effectiveTaskName ? { taskName: effectiveTaskName } : {}),
              projectId: params.projectId,
              result: params.result,
              deliveryArtifacts,
              reviewRequired: true,
              taskReport: {
                ...taskReport,
                status: (taskReport.status === 'in_progress' || taskReport.status === 'blocked')
                  ? 'review_ready'
                  : taskReport.status,
                nextAction: 'review',
              },
            },
            queueOnBusy: true,
            maxQueueWaitMs: 0,
          } as unknown as Record<string, unknown>) as {
            ok?: boolean;
            dispatchId?: string;
            status?: 'queued' | 'completed' | 'failed';
            error?: string;
          };

          if (!reviewDispatch?.ok || reviewDispatch.status === 'failed') {
            return {
              ok: false,
              action: 'report',
              dispatchId: reviewDispatch?.dispatchId,
              status: reviewDispatch?.status,
              error: reviewDispatch?.error ?? 'dispatch to review agent failed',
            };
          }

          updateProjectTaskStateForSession(deps, reviewRoute.projectSessionId ?? params.sessionId, {
            active: true,
            status: 'waiting_review',
            taskId: effectiveTaskId || params.taskId,
            taskName: effectiveTaskName || taskName || undefined,
            dispatchId: reviewDispatch.dispatchId,
            summary: 'delivery submitted to reviewer',
            note: 'waiting_review',
          });
          updateProjectTaskStateForSession(deps, reviewRoute.parentSessionId, {
            active: true,
            status: 'waiting_review',
            taskId: effectiveTaskId || params.taskId,
            taskName: effectiveTaskName || taskName || undefined,
            dispatchId: reviewDispatch.dispatchId,
            summary: 'project delivery under reviewer validation',
            note: 'waiting_review',
          });

          return {
            ok: true,
            action: 'report',
            dispatchId: reviewDispatch.dispatchId,
            status: reviewDispatch.status,
          };
        }

        // Reviewer reject -> Project redispatch (do not notify system on reject path)
        if (reviewRoute?.reviewRequired && isReviewerCaller && params.result === 'failure') {
          const rejectPrompt = [
            '[REVIEW REJECTED — REWORK REQUIRED]',
            `任务ID: ${effectiveTaskId || params.taskId}`,
            effectiveTaskName ? `任务名: ${effectiveTaskName}` : '',
            `项目: ${params.projectId}`,
            reviewRoute.acceptanceCriteria ? `验收标准: ${reviewRoute.acceptanceCriteria}` : '',
            '',
            'reviewer 已拒绝当前交付，请基于以下反馈继续修复：',
            normalizedSummary || '(no summary)',
            deliveryArtifacts ? `交付线索: ${deliveryArtifacts}` : '',
            '',
            '要求：',
            '- 完整覆盖任务目标与验收标准',
            '- 提供明确变更与验证证据（文件/命令/测试）',
            '- 完成后再次调用 report-task-completion 上报',
          ].filter(Boolean).join('\n');

          const rejectDispatch = await deps.agentRuntimeBlock.execute('dispatch', {
            sourceAgentId: callerAgentId || 'finger-reviewer',
            targetAgentId: 'finger-project-agent',
            task: { prompt: rejectPrompt },
            sessionId: reviewRoute.projectSessionId ?? params.sessionId,
            blocking: false,
            metadata: {
              source: 'review-reject-redispatch',
              role: 'system',
              taskId: effectiveTaskId || params.taskId,
              ...(effectiveTaskName ? { taskName: effectiveTaskName } : {}),
              projectId: params.projectId,
              reviewRequired: true,
              reviewDecision: 'reject',
              reviewerFeedback: normalizedSummary,
              deliveryArtifacts,
              taskReport: {
                ...taskReport,
                status: 'needs_rework',
                nextAction: 'rework',
                reviewDecision: 'reject',
                deliveryClaim: false,
              },
            },
            queueOnBusy: true,
            maxQueueWaitMs: 0,
          } as unknown as Record<string, unknown>) as {
            ok?: boolean;
            dispatchId?: string;
            status?: 'queued' | 'completed' | 'failed';
            error?: string;
          };

          if (!rejectDispatch?.ok || rejectDispatch.status === 'failed') {
            return {
              ok: false,
              action: 'report',
              dispatchId: rejectDispatch?.dispatchId,
              status: rejectDispatch?.status,
              error: rejectDispatch?.error ?? 'review reject redispatch to project failed',
            };
          }

          updateProjectTaskStateForSession(deps, reviewRoute.projectSessionId ?? params.sessionId, {
            active: true,
            status: 'in_progress',
            taskId: effectiveTaskId || params.taskId,
            taskName: effectiveTaskName || taskName || undefined,
            dispatchId: rejectDispatch.dispatchId,
            summary: normalizedSummary || 'review rejected; rework required',
            note: 'review_rejected_redispatch',
          });
          updateProjectTaskStateForSession(deps, reviewRoute.parentSessionId, {
            active: true,
            status: 'in_progress',
            taskId: effectiveTaskId || params.taskId,
            taskName: effectiveTaskName || taskName || undefined,
            dispatchId: rejectDispatch.dispatchId,
            summary: normalizedSummary || 'review rejected; waiting project rework',
            note: 'review_rejected_redispatch',
          });

          return {
            ok: true,
            action: 'continue',
            dispatchId: rejectDispatch.dispatchId,
            status: rejectDispatch.status,
          };
        }

        // Reviewer -> System (pass path)
        const dispatch = await dispatchTaskToSystemAgent(deps, {
          taskId: effectiveTaskId || params.taskId,
          taskSummary: params.taskSummary,
          sessionId: params.sessionId,
          result: params.result,
          projectId: params.projectId,
          deliveryArtifacts,
          sourceAgentId: isReviewerCaller ? (callerAgentId || 'finger-reviewer') : 'finger-project-agent',
          taskName: effectiveTaskName || taskName || undefined,
          taskReport,
          evidence,
          status: taskReport.status,
          nextAction: taskReport.nextAction,
          reviewDecision: taskReport.reviewDecision,
          deliveryClaim: taskReport.deliveryClaim,
        });

        if (isReviewerCaller && dispatch.ok && dispatch.status !== 'failed') {
          removeReviewRoute(effectiveTaskId || params.taskId);
          updateProjectTaskStateForSession(deps, reviewRoute?.projectSessionId ?? params.sessionId, {
            active: params.result !== 'success',
            status: params.result === 'success' ? 'pending_approval' : 'failed',
            taskId: effectiveTaskId || params.taskId,
            taskName: effectiveTaskName || taskName || undefined,
            dispatchId: dispatch.dispatchId,
            summary: params.taskSummary,
            note: params.result === 'success' ? 'review_passed_pending_system_approval' : 'review_failed',
          });
          updateProjectTaskStateForSession(deps, reviewRoute?.parentSessionId, {
            active: params.result !== 'success',
            status: params.result === 'success' ? 'pending_approval' : 'failed',
            taskId: effectiveTaskId || params.taskId,
            taskName: effectiveTaskName || taskName || undefined,
            dispatchId: dispatch.dispatchId,
            summary: params.taskSummary,
            note: params.result === 'success' ? 'review_passed_pending_system_approval' : 'review_failed',
          });
        }

        if (!dispatch.ok || dispatch.status === 'failed') {
          return {
            ok: false,
            action: 'report',
            dispatchId: dispatch.dispatchId,
            status: dispatch.status,
            error: dispatch.error ?? 'dispatch to system agent failed',
          };
        }

        emitTaskCompleted(deps, {
          taskId: effectiveTaskId || params.taskId,
          projectId: params.projectId,
        });

        return {
          ok: true,
          action: 'report',
          dispatchId: dispatch.dispatchId,
          status: dispatch.status,
        };
      } catch (error) {
        return { ok: false, action: 'report', error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}
