/**
 * Project Agent 报告任务完成，附交付标的。
 * V3: 直接上报给 System Agent（无独立 Reviewer）。
 */


import type { ToolRegistry } from '../../runtime/tool-registry.js';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import path from 'path';
import type { AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';
import { logger } from '../../core/logger.js';
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
  parseProjectTaskState,
  PROJECT_AGENT_ID,
  SYSTEM_AGENT_ID,
} from '../../common/project-task-state.js';
import { buildVerificationPrompt } from '../../agents/prompts/verifier-prompts.js';
import { releaseProjectDreamLock } from '../../core/project-dream-lock.js';
import { writeProjectDreamMemory } from '../../core/project-dream-memory-store.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { SYSTEM_PROJECT_PATH } from '../../agents/finger-system-agent/index.js';
import { applyProjectStatusGatewayPatch } from '../../server/modules/project-status-gateway.js';
import { writeFileAtomic } from '../../core/atomic-write.js';

const log = logger.module('report-task-completion-tool');

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
  warnings?: string[];
}

interface DailySystemReviewTask {
  dateKey: string;
}

interface DailySystemReviewBackupConfig {
  enabled: boolean;
  localDir: string;
  obsidianDir?: string;
}

interface DailySystemReviewBaselineEntry {
  name: string;
  targetPath: string;
  existed: boolean;
  snapshotPath?: string;
}

interface DailySystemReviewDispatchState {
  date?: string;
  status?: string;
  runId?: string;
  appendOnly?: boolean;
  backup?: DailySystemReviewBackupConfig;
  baseline?: DailySystemReviewBaselineEntry[];
  note?: string;
}

const HEARTBEAT_RUNTIME_STATE_PATH = path.join(
  FINGER_PATHS.runtime.schedulesDir,
  'heartbeat-runtime-state.json',
);
const HEARTBEAT_CONFIG_PATH = path.join(
  FINGER_PATHS.runtime.schedulesDir,
  'heartbeat-config.jsonl',
);
const DEFAULT_DAILY_SYSTEM_REVIEW_BACKUP_LOCAL_DIR = path.join(
  FINGER_PATHS.home,
  'system',
  'backup',
  'daily-review',
);
const DEFAULT_DAILY_SYSTEM_REVIEW_BACKUP_OBSIDIAN_DIR = '~/Documents/Obsidian/finger日志/backups/daily-review';

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

function inferVerificationChangeCategoryFromFiles(
  changedFiles: string[],
): 'backend_api' | 'infrastructure' | 'frontend' | 'config' | 'multi_file' {
  if (changedFiles.length >= 3) return 'multi_file';
  if (changedFiles.some((file) => /(^|\/)(api|server|runtime|backend)(\/|$)/i.test(file))) return 'backend_api';
  if (changedFiles.some((file) => /(Dockerfile|docker-compose|k8s|infra|deployment|helm|terraform)/i.test(file))) return 'infrastructure';
  if (changedFiles.some((file) => /(^|\/)(ui|web|frontend)(\/|$)|\.(tsx?|jsx?)$/i.test(file))) return 'frontend';
  if (changedFiles.some((file) => /\.(json|ya?ml|toml|ini)$/i.test(file) || /config/i.test(file))) return 'config';
  return 'multi_file';
}

function extractChangedFilesFromReportPayload(input: {
  summary: string;
  artifacts: string;
  evidence?: string[] | string;
}): string[] {
  const evidenceText = Array.isArray(input.evidence)
    ? input.evidence.join('\n')
    : typeof input.evidence === 'string'
      ? input.evidence
      : '';
  const text = [input.summary, input.artifacts, evidenceText].filter(Boolean).join('\n');
  const matches = text.match(/(?:~\/|\/)[^\s"'`]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8}/g) ?? [];
  return matches
    .map((item) => item.trim())
    .filter((item, index, arr) => item.length > 0 && arr.indexOf(item) === index)
    .slice(0, 24);
}

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

function parseNightlyDreamTaskId(taskId: string): { projectSlug: string; dateKey: string } | null {
  const normalized = typeof taskId === 'string' ? taskId.trim() : '';
  if (!normalized.startsWith('nightly-dream:')) return null;
  const parts = normalized.split(':');
  if (parts.length !== 3) return null;
  const projectSlug = parts[1]?.trim() ?? '';
  const dateKey = parts[2]?.trim() ?? '';
  if (!projectSlug || !dateKey) return null;
  return { projectSlug, dateKey };
}

function parseDailySystemReviewTaskId(taskId: string): DailySystemReviewTask | null {
  const normalized = typeof taskId === 'string' ? taskId.trim() : '';
  if (!normalized.startsWith('daily-system-review:')) return null;
  const parts = normalized.split(':');
  if (parts.length !== 2) return null;
  const dateKey = parts[1]?.trim() ?? '';
  if (!dateKey) return null;
  return { dateKey };
}

function expandHomePath(inputPath: string): string {
  if (!inputPath.startsWith('~/')) return inputPath;
  return path.join(homedir(), inputPath.slice(2));
}

function normalizeDailyReviewObsidianDir(rawValue: unknown): string | undefined {
  if (typeof rawValue !== 'string') return undefined;
  const trimmed = rawValue.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes('/Documents/ObsidianVault/')) {
    return DEFAULT_DAILY_SYSTEM_REVIEW_BACKUP_OBSIDIAN_DIR;
  }
  const homePrefix = `${homedir()}/`;
  if (trimmed.startsWith(homePrefix)) {
    return `~/${trimmed.slice(homePrefix.length)}`;
  }
  return trimmed;
}

function resolveDailySystemReviewTargets(): Array<{ name: string; targetPath: string }> {
  return [
    { name: 'USER.md', targetPath: path.join(FINGER_PATHS.home, 'USER.md') },
    { name: 'FLOW.md', targetPath: path.join(SYSTEM_PROJECT_PATH, 'FLOW.md') },
    { name: 'MEMORY.md', targetPath: path.join(SYSTEM_PROJECT_PATH, 'MEMORY.md') },
  ];
}

async function readLatestDailySystemReviewBackupConfig(): Promise<DailySystemReviewBackupConfig> {
  const fallback: DailySystemReviewBackupConfig = {
    enabled: false,
    localDir: DEFAULT_DAILY_SYSTEM_REVIEW_BACKUP_LOCAL_DIR,
  };
  let raw = '';
  try {
    raw = await fs.readFile(HEARTBEAT_CONFIG_PATH, 'utf-8');
  } catch {
    return fallback;
  }
  const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]) as {
        type?: unknown;
        config?: {
          dailySystemReview?: {
            backup?: {
              enabled?: boolean;
              localDir?: string;
              obsidianDir?: string;
            };
          };
        };
      };
      if (parsed?.type !== 'heartbeat_config') continue;
      const rawBackup = parsed.config?.dailySystemReview?.backup;
      const localDir = typeof rawBackup?.localDir === 'string' && rawBackup.localDir.trim().length > 0
        ? rawBackup.localDir.trim()
        : DEFAULT_DAILY_SYSTEM_REVIEW_BACKUP_LOCAL_DIR;
      const obsidianDir = normalizeDailyReviewObsidianDir(rawBackup?.obsidianDir);
      return {
        enabled: rawBackup?.enabled === true,
        localDir,
        ...(obsidianDir ? { obsidianDir } : {}),
      };
    } catch {
      // Ignore malformed historical line; keep scanning backwards.
    }
  }
  return fallback;
}

async function loadDailySystemReviewDispatchState(
  taskId: string,
  dateKey: string,
): Promise<{ state: DailySystemReviewDispatchState | null; runtimeState: Record<string, unknown> }> {
  try {
    const raw = await fs.readFile(HEARTBEAT_RUNTIME_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const dispatchState = parsed.dailySystemReviewDispatchState;
    if (!dispatchState || typeof dispatchState !== 'object') {
      return { state: null, runtimeState: parsed };
    }
    const state = dispatchState as DailySystemReviewDispatchState;
    const runId = typeof state.runId === 'string' ? state.runId.trim() : '';
    const stateDate = typeof state.date === 'string' ? state.date.trim() : '';
    if ((runId && runId !== taskId) || (stateDate && stateDate !== dateKey)) {
      return { state: null, runtimeState: parsed };
    }
    return { state, runtimeState: parsed };
  } catch {
    return { state: null, runtimeState: {} };
  }
}

async function persistDailySystemReviewDispatchState(
  runtimeState: Record<string, unknown>,
  next: DailySystemReviewDispatchState,
): Promise<void> {
  const updated = {
    ...runtimeState,
    dailySystemReviewDispatchState: next,
  };
  await writeFileAtomic(HEARTBEAT_RUNTIME_STATE_PATH, JSON.stringify(updated, null, 2));
}

async function verifyDailySystemReviewAppendOnly(
  baseline: DailySystemReviewBaselineEntry[],
): Promise<{ ok: boolean; violations: string[] }> {
  const violations: string[] = [];
  for (const entry of baseline) {
    if (!entry.existed) continue;
    if (typeof entry.snapshotPath !== 'string' || entry.snapshotPath.trim().length === 0) {
      violations.push(`${entry.name}: missing baseline snapshot`);
      continue;
    }
    let snapshotContent = '';
    let currentContent = '';
    try {
      snapshotContent = await fs.readFile(entry.snapshotPath, 'utf-8');
    } catch (error) {
      violations.push(`${entry.name}: baseline read failed (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    try {
      currentContent = await fs.readFile(entry.targetPath, 'utf-8');
    } catch (error) {
      violations.push(`${entry.name}: current read failed (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (!currentContent.startsWith(snapshotContent)) {
      violations.push(`${entry.name}: append-only violation (content prefix mismatch)`);
    }
  }
  return { ok: violations.length === 0, violations };
}

async function runDailySystemReviewBackups(params: {
  dateKey: string;
  backup: DailySystemReviewBackupConfig;
  targets: Array<{ name: string; targetPath: string }>;
}): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  const localRoot = path.join(expandHomePath(params.backup.localDir), params.dateKey);
  try {
    await fs.mkdir(localRoot, { recursive: true });
  } catch (error) {
    warnings.push(`local backup root mkdir failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const obsidianRoot = params.backup.enabled && params.backup.obsidianDir
    ? path.join(expandHomePath(params.backup.obsidianDir), params.dateKey)
    : undefined;
  if (obsidianRoot) {
    try {
      await fs.mkdir(obsidianRoot, { recursive: true });
    } catch (error) {
      warnings.push(`obsidian backup root mkdir failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const target of params.targets) {
    const sourcePath = target.targetPath;
    try {
      await fs.access(sourcePath);
    } catch {
      continue;
    }
    const localTargetPath = path.join(localRoot, target.name);
    try {
      await fs.copyFile(sourcePath, localTargetPath);
    } catch (error) {
      warnings.push(`${target.name}: local backup copy failed (${error instanceof Error ? error.message : String(error)})`);
    }
    if (obsidianRoot) {
      const obsidianTargetPath = path.join(obsidianRoot, target.name);
      try {
        await fs.copyFile(sourcePath, obsidianTargetPath);
      } catch (error) {
        warnings.push(`${target.name}: obsidian backup copy failed (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }
  return { warnings };
}

function resolveHighSignalItemsCount(summary: string, artifacts: string, evidence?: string[] | string): number {
  const evidenceCount = Array.isArray(evidence)
    ? evidence.filter((item) => typeof item === 'string' && item.trim().length > 0).length
    : typeof evidence === 'string'
      ? evidence.split('\n').map((item) => item.trim()).filter((item) => item.length > 0).length
      : 0;
  const text = `${summary}\n${artifacts}`.toLowerCase();
  const keywordHits = ['rule', 'guardrail', 'playbook', 'delivery pattern', '规则', '防呆', '交付模式', '模板']
    .filter((keyword) => text.includes(keyword))
    .length;
  return Math.max(evidenceCount, keywordHits);
}

function resolveNoiseDroppedCount(artifacts: string): number {
  const text = typeof artifacts === 'string' ? artifacts : '';
  const hit = text.match(/noise[_\s-]?dropped[_\s-]?count\s*[:=]\s*(\d+)/i);
  if (!hit) return 0;
  const value = Number.parseInt(hit[1] ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function updateProjectTaskStateForSession(
  deps: AgentRuntimeDeps,
  sessionId: string | undefined,
  patch: {
    active?: boolean;
    status?: 'create' | 'dispatched' | 'accepted' | 'in_progress' | 'claiming_finished' | 'reviewed' | 'reported' | 'closed' | 'blocked' | 'failed' | 'cancelled';
    assigneeWorkerId?: string;
    deliveryWorkerId?: string;
        reassignReason?: string;
    taskId?: string;
    taskName?: string;
    dispatchId?: string;
    summary?: string;
    note?: string;
  },
): void {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) return;
  const result = applyProjectStatusGatewayPatch({
    sessionManager: deps.sessionManager,
    sessionIds: [normalizedSessionId],
    source: 'report-task-completion.updateProjectTaskStateForSession',
    patch: {
      ...patch,
      sourceAgentId: SYSTEM_AGENT_ID,
      targetAgentId: PROJECT_AGENT_ID,
    },
  });
  if (!result.ok && result.errors.length > 0) {
    for (const item of result.errors) {
    log.warn('[report-task-completion] Failed to update project task state', {
      sessionId: item.sessionId,
      taskId: patch.taskId,
      taskName: patch.taskName,
      status: patch.status,
      error: item.error,
    });
    }
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
        const isSystemAgentCaller = callerAgentId.toLowerCase().includes('system');
        const reviewRoute = taskId
          ? getReviewRoute(taskId) ?? (taskName ? getReviewRouteByTaskName(taskName) : undefined)
          : (taskName ? getReviewRouteByTaskName(taskName) : undefined);
        const routeTaskId = typeof reviewRoute?.taskId === 'string' ? reviewRoute.taskId.trim() : '';
        const effectiveTaskId = routeTaskId || taskId;
        const routeTaskName = typeof reviewRoute?.taskName === 'string' ? reviewRoute.taskName.trim() : '';
        const effectiveTaskName = routeTaskName || taskName;
        const nightlyDreamTask = parseNightlyDreamTaskId(effectiveTaskId || params.taskId);
        const dailySystemReviewTask = parseDailySystemReviewTaskId(effectiveTaskId || params.taskId);
        const normalizedSummary = normalizeText(params.taskSummary);
        const taskReport: TaskReportContract = buildTaskReportContract({
          taskId: effectiveTaskId || params.taskId,
          taskName: effectiveTaskName || taskName || undefined,
          sessionId: params.sessionId,
          projectId: params.projectId,
          sourceAgentId: isSystemAgentCaller ? (callerAgentId || 'finger-system-agent') : 'finger-project-agent',
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

        if (nightlyDreamTask && !reviewRoute) {
          const nightlyStartedAt = Date.now();
          let memoryWrite:
            | { projectRoot: string; memoryIndexPath: string; dreamStatePath: string; assetPath: string }
            | undefined;
          const changedFiles = extractChangedFilesFromReportPayload({
            summary: normalizedSummary,
            artifacts: deliveryArtifacts,
            evidence,
          });
          const highSignalItemsCount = resolveHighSignalItemsCount(normalizedSummary, deliveryArtifacts, evidence);
          const noiseDroppedCount = resolveNoiseDroppedCount(deliveryArtifacts);
          try {
            memoryWrite = await writeProjectDreamMemory({
              projectSlug: nightlyDreamTask.projectSlug,
              taskId: effectiveTaskId || params.taskId,
              projectId: params.projectId,
              status: taskReport.status,
              result: params.result,
              summary: normalizedSummary,
              deliveryArtifacts,
              evidence,
            });
          } catch (error) {
            return {
              ok: false,
              action: 'report',
              error: `nightly dream memory write failed: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          const enrichedArtifacts = [
            deliveryArtifacts,
            memoryWrite ? `project_memory_asset=${memoryWrite.assetPath}` : '',
            memoryWrite ? `project_memory_index=${memoryWrite.memoryIndexPath}` : '',
          ].filter(Boolean).join('\n');
          const dispatch = await dispatchTaskToSystemAgent(deps, {
            taskId: effectiveTaskId || params.taskId,
            taskSummary: params.taskSummary,
            sessionId: params.sessionId,
            result: params.result,
            projectId: params.projectId,
            deliveryArtifacts: enrichedArtifacts,
            sourceAgentId: isSystemAgentCaller ? (callerAgentId || 'finger-system-agent') : 'finger-project-agent',
            taskName: effectiveTaskName || taskName || undefined,
            taskReport,
            evidence,
            status: taskReport.status,
            nextAction: taskReport.nextAction,
            reviewDecision: taskReport.reviewDecision,
            deliveryClaim: taskReport.deliveryClaim,
          });
          const lockRelease = await releaseProjectDreamLock({
            projectSlug: nightlyDreamTask.projectSlug,
            runId: effectiveTaskId || params.taskId,
          });
          if (!lockRelease.released && lockRelease.reason !== 'missing') {
            log.warn('[report-task-completion] nightly dream lock release not released', {
              taskId: effectiveTaskId || params.taskId,
              projectSlug: nightlyDreamTask.projectSlug,
              reason: lockRelease.reason,
              existingRunId: lockRelease.existingRunId,
            });
          }
          if (!dispatch.ok || dispatch.status === 'failed') {
            log.warn('[report-task-completion] nightly dream dispatch to system failed', {
              dream_run_id: effectiveTaskId || params.taskId,
              project_slug: nightlyDreamTask.projectSlug,
              source: 'nightly-dream',
              status: 'failed',
              duration_ms: Date.now() - nightlyStartedAt,
              changed_files_count: changedFiles.length,
              high_signal_items_count: highSignalItemsCount,
              noise_dropped_count: noiseDroppedCount,
              error: dispatch.error ?? 'dispatch to system agent failed',
            });
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
          log.info('[report-task-completion] nightly dream terminal report', {
            dream_run_id: effectiveTaskId || params.taskId,
            project_slug: nightlyDreamTask.projectSlug,
            source: 'nightly-dream',
            status: params.result === 'success' ? 'completed' : 'failed',
            duration_ms: Date.now() - nightlyStartedAt,
            changed_files_count: changedFiles.length,
            high_signal_items_count: highSignalItemsCount,
            noise_dropped_count: noiseDroppedCount,
          });
          return {
            ok: true,
            action: 'report',
            dispatchId: dispatch.dispatchId,
            status: dispatch.status,
          };
        }

        if (dailySystemReviewTask && !reviewRoute) {
          const targets = resolveDailySystemReviewTargets();
          const { state: dailyDispatchState, runtimeState } = await loadDailySystemReviewDispatchState(
            effectiveTaskId || params.taskId,
            dailySystemReviewTask.dateKey,
          );
          const appendOnly = dailyDispatchState?.appendOnly !== false;
          const baseline = Array.isArray(dailyDispatchState?.baseline)
            ? dailyDispatchState?.baseline
            : [];
          if (appendOnly && baseline.length > 0) {
            const appendOnlyResult = await verifyDailySystemReviewAppendOnly(baseline);
            if (!appendOnlyResult.ok) {
              await persistDailySystemReviewDispatchState(runtimeState, {
                ...(dailyDispatchState ?? {}),
                date: dailySystemReviewTask.dateKey,
                status: 'failed',
                runId: effectiveTaskId || params.taskId,
                note: `append_only_violation:${appendOnlyResult.violations.join(' | ')}`,
              });
              return {
                ok: false,
                action: 'report',
                status: 'failed',
                error: `daily system review append-only violation: ${appendOnlyResult.violations.join('; ')}`,
              };
            }
          }

          const backup = dailyDispatchState?.backup ?? await readLatestDailySystemReviewBackupConfig();
          const backupResult = await runDailySystemReviewBackups({
            dateKey: dailySystemReviewTask.dateKey,
            backup,
            targets,
          });

          await persistDailySystemReviewDispatchState(runtimeState, {
            ...(dailyDispatchState ?? {}),
            date: dailySystemReviewTask.dateKey,
            status: params.result === 'success' ? 'completed' : 'failed',
            runId: effectiveTaskId || params.taskId,
            appendOnly,
            backup,
            ...(backupResult.warnings.length > 0
              ? { note: `backup_warning:${backupResult.warnings.join(' | ')}` }
              : {}),
          });
          emitTaskCompleted(deps, {
            taskId: effectiveTaskId || params.taskId,
            projectId: params.projectId,
          });
          return {
            ok: true,
            action: 'report',
            status: 'completed',
            ...(backupResult.warnings.length > 0 ? { warnings: backupResult.warnings } : {}),
          };
        }

        // Project -> Reviewer
        if (!isSystemAgentCaller && !reviewRoute) {
          return {
            ok: false,
            action: 'report',
            error: `review route missing for task ${taskId || taskName}; review pipeline is fail-closed`,
          };
        }

        if (reviewRoute?.reviewRequired && !isSystemAgentCaller && !hasClaim) {
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
            sourceAgentId: 'finger-system-agent',
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

        if (reviewRoute?.reviewRequired && !isSystemAgentCaller) {
          const reviewProjectPath = (() => {
            const routeSessionId = typeof reviewRoute.projectSessionId === 'string' && reviewRoute.projectSessionId.trim().length > 0
              ? reviewRoute.projectSessionId.trim()
              : '';
            const fallbackSessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
            const routeSession = routeSessionId ? deps.sessionManager.getSession(routeSessionId) : undefined;
            const fallbackSession = fallbackSessionId ? deps.sessionManager.getSession(fallbackSessionId) : undefined;
            const routePath = typeof routeSession?.projectPath === 'string' ? routeSession.projectPath.trim() : '';
            const fallbackPath = typeof fallbackSession?.projectPath === 'string' ? fallbackSession.projectPath.trim() : '';
            return routePath || fallbackPath || process.cwd();
          })();
          const normalizedEvidenceForChangedFiles = Array.isArray(taskReport.evidence)
            ? taskReport.evidence
              .map((item) => [item.location, item.source, item.details].filter((part) => typeof part === 'string' && part.trim().length > 0).join(' '))
              .filter((line) => line.length > 0)
            : undefined;
          const changedFiles = extractChangedFilesFromReportPayload({
            summary: normalizedSummary,
            artifacts: deliveryArtifacts,
            evidence: normalizedEvidenceForChangedFiles,
          });
          const acceptanceCriteria = reviewRoute.acceptanceCriteria
            ? reviewRoute.acceptanceCriteria
              .split(/\n|;/)
              .map((item) => item.trim())
              .filter((item) => item.length > 0)
            : ['Validate delivery against the task objective and provide concrete evidence.'];
          const reviewPrompt = [
            '[Project Delivery for Review]',
            `taskId: ${effectiveTaskId || 'N/A'}`,
            effectiveTaskName ? `taskName: ${effectiveTaskName}` : '',
            `projectId: ${params.projectId}`,
            `result: ${params.result}`,
            deliveryArtifacts ? `deliveryArtifacts: ${deliveryArtifacts}` : '',
            '',
            buildVerificationPrompt({
              changedFiles: changedFiles.length > 0 ? changedFiles : ['(unspecified-by-project-agent)'],
              changeCategory: inferVerificationChangeCategoryFromFiles(changedFiles),
              implementationSummary: normalizedSummary,
              acceptanceCriteria,
            }),
            '',
            '[Decision Contract]',
            'Return one JSON decision on the last line:',
            '{"decision":"pass|retry|block","summary":"...","evidence":["..."]}',
            'PASS -> pass; PARTIAL/FAIL -> retry (or block if truly blocked).',
            'Then call report-task-completion:',
            '- pass => result=success',
            '- retry/block => result=failure and include system agent review summary/evidence',
          ].filter(Boolean).join('\n');

          const reviewDispatch = await deps.agentRuntimeBlock.execute('dispatch', {
            sourceAgentId: 'finger-project-agent',
            targetAgentId: 'finger-system-agent',
            task: { prompt: reviewPrompt },
            projectPath: reviewProjectPath,
            blocking: false,
            metadata: {
              source: 'project-delivery-report',
              role: 'system',
              cwd: reviewProjectPath,
              projectPath: reviewProjectPath,
              sessionPersistence: 'none',
              persistSession: false,
              transientLedger: true,
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
            status: 'claiming_finished',
            taskId: effectiveTaskId || params.taskId,
            taskName: effectiveTaskName || taskName || undefined,
            dispatchId: reviewDispatch.dispatchId,
            summary: 'delivery submitted to system agent for review',
            note: 'claiming_finished_waiting_system_review',
          });
          updateProjectTaskStateForSession(deps, reviewRoute.parentSessionId, {
            active: true,
            status: 'claiming_finished',
            taskId: effectiveTaskId || params.taskId,
            taskName: effectiveTaskName || taskName || undefined,
            dispatchId: reviewDispatch.dispatchId,
            summary: 'project delivery under system agent review',
            note: 'claiming_finished_waiting_system_review',
          });

          return {
            ok: true,
            action: 'report',
            dispatchId: reviewDispatch.dispatchId,
            status: reviewDispatch.status,
          };
        }

        // Reviewer reject -> Project redispatch (do not notify system on reject path)
        if (reviewRoute?.reviewRequired && isSystemAgentCaller && params.result === 'failure') {
          const rejectPrompt = [
            '[REVIEW REJECTED — REWORK REQUIRED]',
            `任务ID: ${effectiveTaskId || params.taskId}`,
            effectiveTaskName ? `任务名: ${effectiveTaskName}` : '',
            `项目: ${params.projectId}`,
            reviewRoute.acceptanceCriteria ? `验收标准: ${reviewRoute.acceptanceCriteria}` : '',
            '',
            'system agent 已拒绝当前交付，请基于以下反馈继续修复：',
            normalizedSummary || '(no summary)',
            deliveryArtifacts ? `交付线索: ${deliveryArtifacts}` : '',
            '',
            '要求：',
            '- 完整覆盖任务目标与验收标准',
            '- 提供明确变更与验证证据（文件/命令/测试）',
            '- 完成后再次调用 report-task-completion 上报',
          ].filter(Boolean).join('\n');

          const rejectDispatch = await deps.agentRuntimeBlock.execute('dispatch', {
            sourceAgentId: callerAgentId || 'finger-system-agent',
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
          sourceAgentId: isSystemAgentCaller ? (callerAgentId || 'finger-system-agent') : 'finger-project-agent',
          taskName: effectiveTaskName || taskName || undefined,
          taskReport,
          evidence,
          status: taskReport.status,
          nextAction: taskReport.nextAction,
          reviewDecision: taskReport.reviewDecision,
          deliveryClaim: taskReport.deliveryClaim,
        });

        if (isSystemAgentCaller && dispatch.ok && dispatch.status !== 'failed') {
          removeReviewRoute(effectiveTaskId || params.taskId);
          updateProjectTaskStateForSession(deps, reviewRoute?.projectSessionId ?? params.sessionId, {
            active: true,
            status: params.result === 'success' ? 'reviewed' : 'failed',
            taskId: effectiveTaskId || params.taskId,
            taskName: effectiveTaskName || taskName || undefined,
            dispatchId: dispatch.dispatchId,
            summary: params.taskSummary,
            note: params.result === 'success' ? 'review_passed_waiting_system_report' : 'review_failed',
          });
          updateProjectTaskStateForSession(deps, reviewRoute?.parentSessionId, {
            active: params.result === 'success',
            status: params.result === 'success' ? 'reported' : 'failed',
            taskId: effectiveTaskId || params.taskId,
            taskName: effectiveTaskName || taskName || undefined,
            dispatchId: dispatch.dispatchId,
            summary: params.taskSummary,
            note: params.result === 'success'
              ? 'system_report_pending_user_approval'
              : 'review_failed',
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
