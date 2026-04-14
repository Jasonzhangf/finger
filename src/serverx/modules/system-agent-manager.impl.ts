/**
 * System Agent Manager
 *
 * 在 daemon 中启动 System Agent 的定时检查任务
 */

import type { AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';
import { PeriodicCheckRunner } from '../../agents/finger-system-agent/periodic-check.js';
import { loadRegistry } from '../../agents/finger-system-agent/registry.js';
import type { AgentInfo } from '../../agents/finger-system-agent/registry.js';
import { SYSTEM_AGENT_CONFIG } from '../../agents/finger-system-agent/index.js';
import { FINGER_PROJECT_AGENT_ID, FINGER_SYSTEM_AGENT_ID } from '../../agents/finger-general/finger-general-module.js';
import { logger } from '../../core/logger.js';
import { FINGER_PATHS, resolveFingerHome } from '../../core/finger-paths.js';
import { promises as fs } from 'fs';
import path from 'path';
import {
  applyExecutionLifecycleTransition,
  getExecutionLifecycleState,
  type ExecutionLifecycleState,
} from '../../server/modules/execution-lifecycle.js';
import {
  isProjectTaskStateActive,
  mergeProjectTaskState,
  parseDelegatedProjectTaskRegistry,
  parseProjectTaskState,
  type ProjectTaskState,
  upsertDelegatedProjectTaskRegistry,
} from '../../common/project-task-state.js';
import {
  buildCompletedExecutionReviewPrompt,
  buildInterruptedExecutionResumePrompt,
  getStartupReviewCheckpoint,
} from '../../server/modules/system-agent-manager-recovery.js';

const log = logger.module('SystemAgentManager');
const DEFAULT_PERIODIC_CHECK_INTERVAL_MS = 5 * 60_000;
const SYSTEM_AGENT_MANAGER_CONFIG_PATH = path.join(FINGER_PATHS.config.dir, 'system-agent-manager.json');
const getSystemProjectPath = (): string => path.join(resolveFingerHome(), 'system');
const SYSTEM_SESSION_PREFIX = 'system-';
const SYSTEM_AGENT_ID = 'finger-system-agent';
const ACTIVE_LIFECYCLE_STAGES = new Set([
  'received',
  'session_bound',
  'dispatching',
  'running',
  'waiting_tool',
  'waiting_model',
  'retrying',
  'interrupted',
]);
const ACTIVE_PROJECT_TASK_RECOVERY_MAX_AGE_MS = 45 * 60_000;
const STARTUP_RECOVERY_IN_FLIGHT = new Set<string>();
const STARTUP_RECOVERY_STEP_TIMEOUT_MS = 45_000;
const SYSTEM_RUNTIME_EXEC_TIMEOUT_MS = 45_000;

interface SystemAgentManagerFileConfig {
  periodicCheck?: {
    enabled?: boolean;
    intervalMs?: number;
  };
}

interface SystemAgentManagerOptions {
  periodicCheck?: {
    enabled?: boolean;
    intervalMs?: number;
  };
}

interface LoopTerminalEvent {
  phase: 'turn_complete' | 'turn_error';
  timestamp?: string;
  finishReason?: string;
  error?: string;
}

interface InflightKernelTurnState {
  hasInFlight: boolean;
  activeTurnId?: string;
  providerId?: string;
}

export class SystemAgentManager {
  private runner: PeriodicCheckRunner | null = null;
  private systemSessionId: string | null = null;
  private started = false;

  constructor(
    private deps: AgentRuntimeDeps,
    private options: SystemAgentManagerOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // 0. 仅确保 registry 可读（监控项目以 registry 为唯一真源，不再从 sessions 自动导入）
    await this.initializeRegistryFromSessions();

    // 1. 创建或获取 System Agent 的 session
    this.systemSessionId = await this.ensureSystemSession();
    this.clearTransientProgressOverrides(this.systemSessionId);
    
    // 2. 部署 System Agent（确保它持续运行）
    await this.deploySystemAgent();

    // 2.5 daemon 重启后，优先处理上一轮执行状态：
    // - 未 stop：直接从中断处继续
    // - 已 stop：做一次交付闭环审查，若未真正完成则继续执行
    await this.handleStartupExecutionState();
    
    
    // 3. 启动定时器（可配置开关，默认开启）
    const periodicCheck = await this.resolvePeriodicCheckConfig();
    if (periodicCheck.enabled) {
      this.runner = new PeriodicCheckRunner(this.deps, {
        intervalMs: periodicCheck.intervalMs,
      });
      this.runner.start();
      log.info('[SystemAgentManager] Periodic check enabled', {
        intervalMs: periodicCheck.intervalMs,
        configPath: SYSTEM_AGENT_MANAGER_CONFIG_PATH,
      });
    } else {
      this.runner = null;
      log.info('[SystemAgentManager] Periodic check disabled by config', {
        configPath: SYSTEM_AGENT_MANAGER_CONFIG_PATH,
      });
    }

    // 4. 立即执行 periodic check（由 PeriodicCheckRunner 启动 monitored agents）
    if (this.runner) {
      await this.runner.runOnceImmediately();
    }

    // 4.5 Reviewer absorbed into system agent - no separate recovery
    await this.recoverReviewerSessionsIfNeeded();

    // 5. 启动后不再自动注入 bootstrap 开机检查（避免无意义负载与忙态干扰）。
    // 如需人工触发，可通过显式 dispatch/system 指令发起。
  }


  private async deploySystemAgent(): Promise<void> {
    try {
      const deployResult = await this.executeRuntimeWithTimeout('deploy', {
        targetAgentId: SYSTEM_AGENT_CONFIG.id,
        sessionId: this.systemSessionId,
        instanceCount: 1,
        launchMode: 'system',
        scope: 'global',
        config: {
          enabled: true,
        },
      }) as unknown as { success: boolean; deployment?: { id: string; status: string }; error?: string };

      if (deployResult.success) {
        log.info('[SystemAgentManager] System Agent deployed successfully', {
          deploymentId: deployResult.deployment?.id,
          status: deployResult.deployment?.status,
        });
      } else {
        log.warn('[SystemAgentManager] Failed to deploy System Agent:', { error: deployResult.error });
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error('[SystemAgentManager] Error deploying System Agent:', error);
    }
  }

  private async ensureSystemSession(): Promise<string> {
    try {
      const session = this.deps.sessionManager.getOrCreateSystemSession();
      const sessionId = session.id;
      log.info(`System session: ${sessionId} (${session.name})`);
      return sessionId;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error('Failed to get or create system session:', error);
      return 'default';
    }
  }

  private clearTransientProgressOverrides(sessionId: string | null): void {
    if (!sessionId) return;
    const session = this.deps.sessionManager.getSession(sessionId);
    const context = (session?.context && typeof session.context === 'object')
      ? (session.context as Record<string, unknown>)
      : {};
    const cleanup: Record<string, unknown> = {};
    if (context.progressDeliveryTransient === true) {
      cleanup.progressDelivery = null;
      cleanup.progressDeliveryTransient = false;
      cleanup.progressDeliveryUpdatedAt = null;
    }
    if (context.scheduledProgressDeliveryTransient === true) {
      cleanup.scheduledProgressDelivery = null;
      cleanup.scheduledProgressDeliveryTransient = false;
    }
    if (Object.keys(cleanup).length > 0) {
      this.deps.sessionManager.updateContext(sessionId, cleanup);
      log.info('[SystemAgentManager] Cleared stale transient progress overrides', {
        sessionId,
        keys: Object.keys(cleanup),
      });
    }
  }

  private async startMonitoredProjects(): Promise<void> {
    try {
      const registry = await loadRegistry();
      const monitoredAgents = Object.values(registry.agents).filter((agent: AgentInfo) => agent.monitored);

      log.info(`Starting ${monitoredAgents.length} monitored Project Agents...`);

      for (const agent of monitoredAgents) {
        try {
          await this.startProjectAgent(agent);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          log.error(`Failed to start agent for project ${agent.projectPath}:`, error);
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error('Failed to start monitored projects:', error);
    }
  }

  private async startProjectAgent(agent: AgentInfo): Promise<void> {
    const { projectPath, projectId, agentId } = agent;
    const normalizedProjectPath = path.resolve(projectPath);
    if (normalizedProjectPath === path.resolve(getSystemProjectPath())) {
      log.warn('[SystemAgentManager] Skip monitored project start for system workspace path', {
        projectPath,
        projectId,
        agentId,
      });
      return;
    }

    log.info(`Starting Project Agent ${agentId} for ${projectId} at ${projectPath}`);
    const sessionId = this.resolveProjectSessionIdForRecovery(agent);
    const deployResult = await this.executeRuntimeWithTimeout('deploy', {
      targetAgentId: FINGER_PROJECT_AGENT_ID,
      sessionId,
      instanceCount: 1,
      launchMode: 'orchestrator',
      scope: 'session',
      config: {
        enabled: true,
      },
    }) as { success?: boolean; deployment?: { id?: string; status?: string }; error?: string };

    if (deployResult?.success) {
      log.info('[SystemAgentManager] Project Agent deployed for monitored project', {
        projectPath,
        projectId,
        sessionId,
        deploymentId: deployResult.deployment?.id,
        deploymentStatus: deployResult.deployment?.status,
      });
    } else {
      log.warn('[SystemAgentManager] Failed to deploy monitored project agent', {
        projectPath,
        projectId,
        sessionId,
        error: deployResult?.error ?? 'unknown',
      });
      return;
    }

    await this.resumeProjectSessionIfNeeded(agent, sessionId);
  }

  private resolveProjectSessionIdForRecovery(agent: AgentInfo): string {
    const projectPath = path.resolve(agent.projectPath);
    const sessionManager = this.deps.sessionManager as {
      getSession?: (sessionId: string) => { id?: string; projectPath?: string; context?: Record<string, unknown> } | null;
      findSessionsByProjectPath?: (projectPath: string) => Array<{ id: string; projectPath: string; lastAccessedAt: string; context?: Record<string, unknown> }>;
      createSession?: (projectPath: string, name?: string, options?: { allowReuse?: boolean }) => { id: string };
      ensureSession?: (sessionId: string, projectPath: string, name?: string) => { id: string };
    };
    const candidateFromRegistry = typeof agent.lastSessionId === 'string'
      ? sessionManager.getSession?.(agent.lastSessionId)
      : null;
    if (candidateFromRegistry
      && !this.deps.isRuntimeChildSession(candidateFromRegistry)
      && !this.isSystemOwnedSessionCandidate(candidateFromRegistry)
      && typeof candidateFromRegistry.projectPath === 'string'
      && candidateFromRegistry.projectPath.trim().length > 0
      && typeof candidateFromRegistry.id === 'string'
      && candidateFromRegistry.id.trim().length > 0
      && path.resolve(candidateFromRegistry.projectPath) === projectPath) {
      return candidateFromRegistry.id;
    }

    const findSessionsByProjectPath = sessionManager.findSessionsByProjectPath;
    const latestRoot = typeof findSessionsByProjectPath === 'function'
      ? findSessionsByProjectPath.call(sessionManager, projectPath)
        .filter((session) => !this.deps.isRuntimeChildSession(session))
        .filter((session) => !this.isSystemOwnedSessionCandidate(session))
        .sort((a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime())[0]
      : undefined;
    if (latestRoot) return latestRoot.id;

    const createSession = sessionManager.createSession;
    if (typeof createSession === 'function') {
      const created = createSession.call(sessionManager, projectPath, agent.projectName, { allowReuse: true });
      if (created?.id) {
        const createdSession = sessionManager.getSession?.(created.id);
        if (!this.isSystemOwnedSessionCandidate(createdSession ?? { id: created.id, projectPath })) {
          return created.id;
        }
      }
    }
    const ensureSession = sessionManager.ensureSession;
    if (typeof ensureSession === 'function') {
      const generatedSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ensured = ensureSession.call(sessionManager, generatedSessionId, projectPath, agent.projectName);
      if (ensured?.id) return ensured.id;
    }
    return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private async resumeProjectSessionIfNeeded(agent: AgentInfo, sessionId: string): Promise<void> {
    let lifecycle = getExecutionLifecycleState(this.deps.sessionManager, sessionId);
    if (lifecycle && this.shouldResetLifecycleAfterRestart(lifecycle)) {
      applyExecutionLifecycleTransition(this.deps.sessionManager, sessionId, {
        stage: 'completed',
        substage: 'startup_reset_after_stop',
        updatedBy: 'system-agent-manager',
        targetAgentId: FINGER_PROJECT_AGENT_ID,
        finishReason: 'stop',
        turnId: lifecycle.turnId,
        dispatchId: lifecycle.dispatchId,
        detail: 'startup reset: project runtime stop was already reached before restart',
      });
      log.info('[SystemAgentManager] Startup reset stale stop lifecycle for monitored project', {
        projectId: agent.projectId,
        projectPath: agent.projectPath,
        sessionId,
        previousStage: lifecycle.stage,
        previousSubstage: lifecycle.substage ?? 'none',
        finishReason: lifecycle.finishReason ?? 'none',
      });
      lifecycle = getExecutionLifecycleState(this.deps.sessionManager, sessionId);
    }
    const inflight = await this.detectInFlightKernelTurn(sessionId);
    const actionableTaskState = this.resolveActionableProjectTaskStateForRecovery(sessionId);
    const taskStateNeedsResume = actionableTaskState !== null;
    log.info('[SystemAgentManager] Startup recovery decision (project)', {
      projectId: agent.projectId,
      projectPath: agent.projectPath,
      sessionId,
      lifecycleStage: lifecycle?.stage ?? 'none',
      lifecycleSubstage: lifecycle?.substage ?? 'none',
      lifecycleFinishReason: lifecycle?.finishReason ?? 'none',
      inFlightKernelTurn: inflight.hasInFlight,
      inFlightKernelTurnId: inflight.activeTurnId,
      inFlightProviderId: inflight.providerId,
      taskStateNeedsResume,
      taskStateSessionId: actionableTaskState?.sessionId,
      taskStateTaskId: actionableTaskState?.state.taskId,
      taskStateStatus: actionableTaskState?.state.status,
    });
    if (!lifecycle && !taskStateNeedsResume) {
      log.info('[SystemAgentManager] Monitored project has no lifecycle state; skip startup recovery', {
        projectId: agent.projectId,
        projectPath: agent.projectPath,
        sessionId,
      });
      return;
    }
    const lifecycleNeedsResume = lifecycle ? (this.shouldResumeLifecycle(lifecycle) && lifecycle.stage !== 'completed') : false;
    const staleCompletedReason = lifecycle
      ? await this.detectStaleCompletedLifecycleForMonitoredProject(sessionId, lifecycle)
      : null;
    const workerRecovery = this.resolveWorkerRecoveryPlan(
      taskStateNeedsResume ? actionableTaskState?.state : null,
    );
    const recoveryWorkerId = workerRecovery.workerId;
    const recoveryReassignReason = workerRecovery.reassignReason;
    if (!lifecycleNeedsResume && !staleCompletedReason && !taskStateNeedsResume) {
      log.info('[SystemAgentManager] Monitored project lifecycle already completed; no recovery needed', {
        projectId: agent.projectId,
        projectPath: agent.projectPath,
        sessionId,
        stage: lifecycle?.stage,
        finishReason: lifecycle?.finishReason ?? 'none',
      });
      return;
    }

    if (taskStateNeedsResume && actionableTaskState) {
      this.patchRecoveredProjectTaskState(actionableTaskState.sessionId, actionableTaskState.state, {
        ...(recoveryWorkerId ? { assigneeWorkerId: recoveryWorkerId } : {}),
        ...(recoveryReassignReason ? { reassignReason: recoveryReassignReason } : {}),
      });
    }

    if (inflight.hasInFlight) {
      log.info('[SystemAgentManager] Skip monitored project recovery dispatch due to in-flight turn', {
        projectId: agent.projectId,
        projectPath: agent.projectPath,
        sessionId,
        lifecycleStage: lifecycle?.stage ?? 'none',
        lifecycleSubstage: lifecycle?.substage ?? 'none',
        activeTurnId: inflight.activeTurnId,
        providerId: inflight.providerId,
        reason: 'skip_recovery_dispatch_due_to_inflight_turn',
      });
      return;
    }

    const prompt = [
      taskStateNeedsResume
        ? `系统重启恢复：检测到项目任务仍处于进行中（task=${actionableTaskState?.state.taskId ?? 'unknown'}，status=${actionableTaskState?.state.status ?? 'in_progress'}）。`
        : staleCompletedReason
          ? `系统重启恢复：检测到该项目会话标记为 completed，但最近一轮出现异常（${staleCompletedReason}）。`
          : '系统重启恢复：检测到该项目会话上一轮未完成。',
      `项目路径：${agent.projectPath}`,
      recoveryWorkerId ? `恢复 worker：${recoveryWorkerId}` : '',
      recoveryReassignReason ? `重分配原因：${recoveryReassignReason}` : '',
      lifecycle?.stage ? `状态：${lifecycle.stage}${lifecycle.substage ? `/${lifecycle.substage}` : ''}` : '状态：<none>',
      '请从当前中断点继续执行，直到任务真正完成（finish_reason=stop）。',
    ].join('\n');

    const result = await this.executeRuntimeWithTimeout('dispatch', {
      sourceAgentId: 'system-project-recovery',
      targetAgentId: FINGER_PROJECT_AGENT_ID,
      task: prompt,
      sessionId,
      metadata: {
        source: 'system-project-recovery',
        role: 'system',
        deliveryMode: 'direct',
        progressDelivery: { mode: 'silent' },
        projectPath: agent.projectPath,
        ...(recoveryWorkerId ? { assigneeWorkerId: recoveryWorkerId, workerId: recoveryWorkerId } : {}),
          recovery: {
            type: 'resume_monitored_project_execution',
            stage: lifecycle?.stage,
            substage: lifecycle?.substage,
            finishReason: lifecycle?.finishReason,
            lastTransitionAt: lifecycle?.lastTransitionAt,
            turnId: lifecycle?.turnId,
            dispatchId: lifecycle?.dispatchId,
            ...(taskStateNeedsResume
              ? {
                  projectTask: {
                    sessionId: actionableTaskState?.sessionId,
                    taskId: actionableTaskState?.state.taskId,
                    taskName: actionableTaskState?.state.taskName,
                    status: actionableTaskState?.state.status,
                    updatedAt: actionableTaskState?.state.updatedAt,
                    note: actionableTaskState?.state.note,
                    ...(recoveryWorkerId ? { assigneeWorkerId: recoveryWorkerId } : {}),
                    ...(recoveryReassignReason ? { reassignReason: recoveryReassignReason } : {}),
                  },
                }
              : {}),
            ...(staleCompletedReason ? { staleCompletedReason } : {}),
          },
        },
        blocking: false,
      }) as { status?: string; dispatchId?: string; ok?: boolean; error?: string };

    log.info('[SystemAgentManager] Monitored project recovery dispatched', {
      projectId: agent.projectId,
      projectPath: agent.projectPath,
      sessionId,
      lifecycleStage: lifecycle?.stage,
      lifecycleSubstage: lifecycle?.substage,
      taskStateNeedsResume,
      taskStateSessionId: actionableTaskState?.sessionId,
      taskStateTaskId: actionableTaskState?.state.taskId,
      staleCompletedReason: staleCompletedReason ?? undefined,
      status: result?.status ?? 'unknown',
      dispatchId: result?.dispatchId,
      error: result?.ok === false ? (result.error ?? 'unknown') : undefined,
    });
  }

  private resolveActionableProjectTaskStateForRecovery(
    primarySessionId: string,
  ): { sessionId: string; state: ProjectTaskState } | null {
    const sessionManager = this.deps.sessionManager as {
      getSession?: (id: string) => { context?: Record<string, unknown> } | null;
      getOrCreateSystemSession?: () => { id?: string } | null;
      findSessionsByProjectPath?: (projectPath: string) => Array<{
        id: string;
        projectPath?: string;
        context?: Record<string, unknown>;
      }>;
    };
    const getSession = sessionManager.getSession;
    if (typeof getSession !== 'function') return null;

    const primarySession = getSession.call(this.deps.sessionManager, primarySessionId);
    const primaryContext = (primarySession?.context && typeof primarySession.context === 'object')
      ? (primarySession.context as Record<string, unknown>)
      : {};
    const linkedRouteSessionId = typeof primaryContext.statusRouteSessionId === 'string'
      ? primaryContext.statusRouteSessionId.trim()
      : '';
    const projectPath = typeof (primarySession as { projectPath?: string } | null)?.projectPath === 'string'
      ? (primarySession as { projectPath?: string }).projectPath!.trim()
      : '';
    const candidates = [primarySessionId, linkedRouteSessionId];

    const findSessionsByProjectPath = sessionManager.findSessionsByProjectPath;
    if (projectPath && typeof findSessionsByProjectPath === 'function') {
      const sameProjectSessions = findSessionsByProjectPath.call(this.deps.sessionManager, projectPath);
      for (const session of sameProjectSessions) {
        if (typeof session?.id !== 'string' || session.id.trim().length === 0) continue;
        candidates.push(session.id.trim());
        const sessionContext = (session.context && typeof session.context === 'object')
          ? (session.context as Record<string, unknown>)
          : {};
        const route = typeof sessionContext.statusRouteSessionId === 'string'
          ? sessionContext.statusRouteSessionId.trim()
          : '';
        if (route) candidates.push(route);
      }
    }
    if (typeof sessionManager.getOrCreateSystemSession === 'function') {
      try {
        const systemSession = sessionManager.getOrCreateSystemSession();
        const systemSessionId = typeof systemSession?.id === 'string' ? systemSession.id.trim() : '';
        if (systemSessionId) candidates.push(systemSessionId);
      } catch (error) {
        log.warn('[SystemAgentManager] Failed to resolve system session while collecting recovery candidates', {
          primarySessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const dedupedCandidates = candidates
      .filter((item, index, list) => item.length > 0 && list.indexOf(item) === index);

    let newest: { sessionId: string; state: ProjectTaskState; updatedAtMs: number } | null = null;

    for (const sessionId of dedupedCandidates) {
      const session = getSession.call(this.deps.sessionManager, sessionId);
      const context = (session?.context && typeof session.context === 'object')
        ? (session.context as Record<string, unknown>)
        : {};
      const state = parseProjectTaskState(context.projectTaskState);
      if (!state) continue;
      if (!isProjectTaskStateActive(state)) continue;
      if (state.targetAgentId !== FINGER_PROJECT_AGENT_ID) continue;
      const updatedAtMs = Date.parse(state.updatedAt);
      if (Number.isFinite(updatedAtMs) && (Date.now() - updatedAtMs) > ACTIVE_PROJECT_TASK_RECOVERY_MAX_AGE_MS) {
        continue;
      }
      const score = Number.isFinite(updatedAtMs) ? updatedAtMs : -1;
      if (!newest || score >= newest.updatedAtMs) {
        newest = {
          sessionId,
          state,
          updatedAtMs: score,
        };
      }
    }
    if (!newest) return null;
    return {
      sessionId: newest.sessionId,
      state: newest.state,
    };
  }

  private resolveWorkerRecoveryPlan(
    state: ProjectTaskState | null,
  ): { workerId?: string; reassignReason?: string } {
    const explicitWorkerId = typeof state?.assigneeWorkerId === 'string'
      ? state.assigneeWorkerId.trim()
      : '';
    if (explicitWorkerId.length > 0) {
      return { workerId: explicitWorkerId };
    }
    if (!state) return {};
    return {
      workerId: FINGER_PROJECT_AGENT_ID,
      reassignReason: 'assignee_worker_missing_reassigned_to_default',
    };
  }

  private patchRecoveredProjectTaskState(
    sessionId: string,
    state: ProjectTaskState,
    patch: {
      assigneeWorkerId?: string;
      reassignReason?: string;
    },
  ): void {
    if (!sessionId.trim()) return;
    const hasPatch = (typeof patch.assigneeWorkerId === 'string' && patch.assigneeWorkerId.trim().length > 0)
      || (typeof patch.reassignReason === 'string' && patch.reassignReason.trim().length > 0);
    if (!hasPatch) return;
    const currentAssignee = typeof state.assigneeWorkerId === 'string' ? state.assigneeWorkerId.trim() : '';
    const nextAssignee = typeof patch.assigneeWorkerId === 'string' ? patch.assigneeWorkerId.trim() : '';
    const currentReassignReason = typeof state.reassignReason === 'string' ? state.reassignReason.trim() : '';
    const nextReassignReason = typeof patch.reassignReason === 'string' ? patch.reassignReason.trim() : '';
    if (currentAssignee === nextAssignee && currentReassignReason === nextReassignReason) return;

    try {
      const session = this.deps.sessionManager.getSession(sessionId);
      if (!session) return;
      const current = parseProjectTaskState(session.context?.projectTaskState);
      if (!current) return;
      const next = mergeProjectTaskState(current, {
        ...(nextAssignee ? { assigneeWorkerId: nextAssignee } : {}),
        ...(nextReassignReason ? { reassignReason: nextReassignReason } : {}),
      });
      const currentRegistry = parseDelegatedProjectTaskRegistry(session.context?.projectTaskRegistry);
      const nextRegistry = upsertDelegatedProjectTaskRegistry(currentRegistry, {
        sourceAgentId: next.sourceAgentId,
        targetAgentId: next.targetAgentId,
        taskId: next.taskId,
        taskName: next.taskName,
        status: next.status,
        active: next.active,
        assigneeWorkerId: next.assigneeWorkerId,
        reassignReason: next.reassignReason,
        dispatchId: next.dispatchId,
        boundSessionId: next.boundSessionId,
        revision: next.revision,
        summary: next.summary,
        note: next.note,
        blockedBy: next.blockedBy,
      });
      this.deps.sessionManager.updateContext(sessionId, {
        projectTaskState: next,
        projectTaskRegistry: nextRegistry,
      });
    } catch (error) {
      log.warn('[SystemAgentManager] Failed to patch recovered project task worker assignment', {
        sessionId,
        taskId: state.taskId,
        assigneeWorkerId: patch.assigneeWorkerId,
        reassignReason: patch.reassignReason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async detectInFlightKernelTurn(sessionId: string): Promise<InflightKernelTurnState> {
    try {
      const result = await this.executeRuntimeWithTimeout('control', {
        action: 'status',
        sessionId,
        targetAgentId: FINGER_PROJECT_AGENT_ID,
      }) as {
        ok?: boolean;
        result?: {
          chatCodexSessions?: unknown[];
        };
      };

      const chatCodexSessions = Array.isArray(result?.result?.chatCodexSessions)
        ? result.result.chatCodexSessions
        : [];
      for (const item of chatCodexSessions) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        const recordSessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
        if (recordSessionId !== sessionId) continue;
        const hasActiveTurn = record.hasActiveTurn === true;
        if (!hasActiveTurn) continue;
        return {
          hasInFlight: true,
          ...(typeof record.activeTurnId === 'string' && record.activeTurnId.trim().length > 0
            ? { activeTurnId: record.activeTurnId.trim() }
            : {}),
          ...(typeof record.providerId === 'string' && record.providerId.trim().length > 0
            ? { providerId: record.providerId.trim() }
            : {}),
        };
      }
      return { hasInFlight: false };
    } catch (error) {
      log.warn('[SystemAgentManager] Failed to inspect in-flight kernel turn for startup recovery', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { hasInFlight: false };
    }
  }

  private isSystemOwnedSessionCandidate(
    session: { id?: string; projectPath?: string; context?: Record<string, unknown> } | null | undefined,
  ): boolean {
    if (!session || typeof session !== 'object') return false;
    const sessionId = typeof session.id === 'string' ? session.id.trim() : '';
    if (sessionId.startsWith(SYSTEM_SESSION_PREFIX)) return true;
    if (sessionId.startsWith('review-') || sessionId.startsWith('hb-')) return true;

    const projectPath = typeof session.projectPath === 'string' ? session.projectPath.trim() : '';
    if (projectPath.length > 0 && path.resolve(projectPath) === path.resolve(getSystemProjectPath())) return true;

    const context = (session.context && typeof session.context === 'object')
      ? (session.context as Record<string, unknown>)
      : {};
    if (context.sessionTier === 'system') return true;
    if (typeof context.ownerAgentId === 'string' && context.ownerAgentId.trim() === SYSTEM_AGENT_ID) return true;
    return false;
  }

  private async detectStaleCompletedLifecycleForMonitoredProject(
    sessionId: string,
    lifecycle: ExecutionLifecycleState,
  ): Promise<string | null> {
    if (lifecycle.stage !== 'completed') return null;
    const finishReason = typeof lifecycle.finishReason === 'string'
      ? lifecycle.finishReason.trim().toLowerCase()
      : '';
    if (finishReason === 'stop') return null;

    const terminal = await this.readLatestLoopTerminalEvent(sessionId, FINGER_PROJECT_AGENT_ID);
    if (!terminal) return null;
    if (terminal.phase === 'turn_error') {
      const errorText = (terminal.error ?? '').trim();
      if (!errorText) return 'latest terminal event is turn_error';
      return `latest terminal event turn_error: ${errorText.slice(0, 120)}`;
    }
    if (terminal.phase === 'turn_complete' && terminal.finishReason && terminal.finishReason !== 'stop') {
      return `latest terminal event turn_complete(${terminal.finishReason})`;
    }
    return null;
  }

  private async readLatestLoopTerminalEvent(
    sessionId: string,
    agentId: string,
  ): Promise<LoopTerminalEvent | null> {
    const session = this.deps.sessionManager.getSession(sessionId) as { context?: Record<string, unknown> } | null;
    const context = (session?.context && typeof session.context === 'object')
      ? (session.context as Record<string, unknown>)
      : {};
    const sessionWorkspaceRoot = typeof context.sessionWorkspaceRoot === 'string'
      ? context.sessionWorkspaceRoot.trim()
      : '';
    if (!sessionWorkspaceRoot) return null;

    const diagnosticsPath = path.join(
      sessionWorkspaceRoot,
      'diagnostics',
      `${agentId}.loop.jsonl`,
    );

    let content = '';
    try {
      content = await fs.readFile(diagnosticsPath, 'utf-8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') {
        log.warn('[SystemAgentManager] Failed to read loop diagnostics for terminal event', {
          sessionId,
          diagnosticsPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return null;
    }

    const lines = content.split('\n');
    for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
      const rawLine = lines[idx]?.trim();
      if (!rawLine) continue;
      try {
        const parsed = JSON.parse(rawLine) as {
          phase?: string;
          timestamp?: string;
          payload?: { finishReason?: string; error?: string };
        };
        if (parsed.phase === 'turn_error') {
          return {
            phase: 'turn_error',
            ...(typeof parsed.timestamp === 'string' ? { timestamp: parsed.timestamp } : {}),
            ...(typeof parsed.payload?.error === 'string' ? { error: parsed.payload.error } : {}),
          };
        }
        if (parsed.phase === 'turn_complete') {
          return {
            phase: 'turn_complete',
            ...(typeof parsed.timestamp === 'string' ? { timestamp: parsed.timestamp } : {}),
            ...(typeof parsed.payload?.finishReason === 'string' ? { finishReason: parsed.payload.finishReason } : {}),
          };
        }
      } catch (error) {
        log.warn('[SystemAgentManager] Ignore malformed loop event line while scanning terminal event', {
          sessionId,
          diagnosticsPath,
          line: rawLine.slice(0, 160),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return null;
  }

  private async recoverReviewerSessionsIfNeeded(): Promise<void> {
    log.info('[SystemAgentManager] Review absorbed into system agent stateless mode');
    return;
  }

  private async handleStartupExecutionState(): Promise<void> {
    if (!this.systemSessionId) return;
    const sessionId = this.systemSessionId;
    if (STARTUP_RECOVERY_IN_FLIGHT.has(sessionId)) {
      log.warn('[SystemAgentManager] Startup recovery already in progress, skip duplicated invocation', {
        sessionId,
      });
      return;
    }
    STARTUP_RECOVERY_IN_FLIGHT.add(sessionId);
    try {
      const lifecycle = getExecutionLifecycleState(this.deps.sessionManager, sessionId);
      if (!lifecycle) {
        log.info('[SystemAgentManager] No startup execution lifecycle found', {
          sessionId,
          stage: 'none',
        });
        return;
      }

      if (this.shouldResetLifecycleAfterRestart(lifecycle)) {
        applyExecutionLifecycleTransition(this.deps.sessionManager, sessionId, {
          stage: 'completed',
          substage: 'startup_reset_after_stop',
          updatedBy: 'system-agent-manager',
          finishReason: 'stop',
          turnId: lifecycle.turnId,
          dispatchId: lifecycle.dispatchId,
          detail: 'startup reset: runtime stop was already reached before restart',
        });
        log.info('[SystemAgentManager] Startup reset stale stop lifecycle to completed', {
          sessionId,
          previousStage: lifecycle.stage,
          previousSubstage: lifecycle.substage ?? 'none',
          finishReason: lifecycle.finishReason ?? 'none',
        });
        return;
      }

      if (this.shouldResumeLifecycle(lifecycle)) {
        try {
          await this.runStartupStepWithTimeout(
            'resumeInterruptedExecution',
            () => this.resumeInterruptedExecution(lifecycle),
          );
        } catch (error) {
          log.error(
            '[SystemAgentManager] Startup resume step failed or timed out',
            error instanceof Error ? error : new Error(String(error)),
            { sessionId, lifecycleStage: lifecycle.stage, lifecycleSubstage: lifecycle.substage ?? 'none' },
          );
        }
        return;
      }

      if (this.shouldReviewCompletedLifecycle(lifecycle)) {
        try {
          await this.runStartupStepWithTimeout(
            'reviewCompletedExecution',
            () => this.reviewCompletedExecution(lifecycle),
          );
        } catch (error) {
          log.error(
            '[SystemAgentManager] Startup review step failed or timed out',
            error instanceof Error ? error : new Error(String(error)),
            { sessionId, lifecycleStage: lifecycle.stage, lifecycleSubstage: lifecycle.substage ?? 'none' },
          );
        }
        return;
      }

      log.info('[SystemAgentManager] Startup execution state requires no action', {
        sessionId,
        stage: lifecycle.stage,
        finishReason: lifecycle.finishReason ?? 'none',
      });
    } finally {
      STARTUP_RECOVERY_IN_FLIGHT.delete(sessionId);
    }
  }

  private async runStartupStepWithTimeout(
    stepName: string,
    runner: () => Promise<void>,
    timeoutMs = STARTUP_RECOVERY_STEP_TIMEOUT_MS,
  ): Promise<void> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const timeoutError = new Error(`[SystemAgentManager] startup step timeout: ${stepName} after ${timeoutMs}ms`);
        (timeoutError as NodeJS.ErrnoException).code = 'SYSTEM_STARTUP_STEP_TIMEOUT';
        reject(timeoutError);
      }, timeoutMs);
    });
    try {
      await Promise.race([runner(), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private shouldResumeLifecycle(lifecycle: ExecutionLifecycleState): boolean {
    const finishReason = typeof lifecycle.finishReason === 'string'
      ? lifecycle.finishReason.trim().toLowerCase()
      : '';
    const substage = typeof lifecycle.substage === 'string'
      ? lifecycle.substage.trim().toLowerCase()
      : '';
    if (finishReason === 'stop') return false;
    if (lifecycle.stage === 'completed') return false;
    if (substage === 'turn_stop_tool_pending') return true;
    if (ACTIVE_LIFECYCLE_STAGES.has(lifecycle.stage)) return true;
    return lifecycle.stage === 'failed';
  }

  private shouldResetLifecycleAfterRestart(lifecycle: ExecutionLifecycleState): boolean {
    const finishReason = typeof lifecycle.finishReason === 'string'
      ? lifecycle.finishReason.trim().toLowerCase()
      : '';
    if (finishReason !== 'stop') return false;
    if (lifecycle.stage !== 'completed') return true;
    const substage = typeof lifecycle.substage === 'string'
      ? lifecycle.substage.trim().toLowerCase()
      : '';
    return substage === 'turn_stop_tool_pending';
  }

  private shouldReviewCompletedLifecycle(lifecycle: ExecutionLifecycleState): boolean {
    const finishReason = typeof lifecycle.finishReason === 'string'
      ? lifecycle.finishReason.trim().toLowerCase()
      : '';
    return finishReason === 'stop';
  }

  private async resumeInterruptedExecution(lifecycle: ExecutionLifecycleState): Promise<void> {
    if (!this.systemSessionId) return;
    const checkpoint = this.buildStartupResumeCheckpoint(lifecycle);
    if (this.hasCompletedStartupResume(checkpoint)) {
      log.info('[SystemAgentManager] Startup interrupted-execution resume already processed', {
        sessionId: this.systemSessionId,
        checkpoint,
      });
      return;
    }

    const hardRecovered = await this.tryResumeInterruptedKernelTurn(lifecycle);
    if (hardRecovered) {
      this.markStartupResumeScheduled(checkpoint);
      return;
    }

    const prompt = buildInterruptedExecutionResumePrompt(lifecycle);
    try {
      const result = await this.executeRuntimeWithTimeout('dispatch', {
        sourceAgentId: 'system-recovery',
        targetAgentId: SYSTEM_AGENT_CONFIG.id,
        task: prompt,
        sessionId: this.systemSessionId,
        metadata: {
          source: 'system-recovery',
          role: 'system',
          deliveryMode: 'direct',
          progressDelivery: { mode: 'silent' },
          recovery: {
            type: 'resume_interrupted_execution',
            stage: lifecycle.stage,
            substage: lifecycle.substage,
            lastTransitionAt: lifecycle.lastTransitionAt,
            turnId: lifecycle.turnId,
            dispatchId: lifecycle.dispatchId,
          },
        },
        blocking: false,
      }) as { ok?: boolean; status?: string; dispatchId?: string; error?: string };

      log.info('[SystemAgentManager] Interrupted execution resume dispatched', {
        sessionId: this.systemSessionId,
        lifecycleStage: lifecycle.stage,
        lifecycleSubstage: lifecycle.substage,
        status: result?.status ?? 'unknown',
        dispatchId: result?.dispatchId,
      });
      this.markStartupResumeScheduled(checkpoint);
    } catch (error) {
      log.error(
        '[SystemAgentManager] Failed to dispatch interrupted execution recovery',
        error instanceof Error ? error : new Error(String(error)),
        {
          sessionId: this.systemSessionId,
          lifecycleStage: lifecycle.stage,
          lifecycleSubstage: lifecycle.substage,
        },
      );
    }
  }

  private buildStartupResumeCheckpoint(lifecycle: ExecutionLifecycleState): string {
    return [
      lifecycle.stage,
      lifecycle.substage ?? '',
      lifecycle.finishReason ?? '',
      lifecycle.turnId ?? '',
      lifecycle.dispatchId ?? '',
      lifecycle.lastTransitionAt,
    ].join('|');
  }

  private hasCompletedStartupResume(checkpoint: string): boolean {
    if (!this.systemSessionId) return false;
    const session = this.deps.sessionManager.getSession(this.systemSessionId);
    const context = (session?.context && typeof session.context === 'object')
      ? (session.context as Record<string, unknown>)
      : {};
    return context.startupResumeCheckpoint === checkpoint;
  }

  private markStartupResumeScheduled(checkpoint: string): void {
    if (!this.systemSessionId) return;
    this.deps.sessionManager.updateContext(this.systemSessionId, {
      startupResumeCheckpoint: checkpoint,
      startupResumeAt: new Date().toISOString(),
    });
  }

  private hasCompletedStartupReview(checkpoint: string): boolean {
    if (!this.systemSessionId) return false;
    const session = this.deps.sessionManager.getSession(this.systemSessionId);
    const context = (session?.context && typeof session.context === 'object')
      ? (session.context as Record<string, unknown>)
      : {};
    return context.startupCompletionReviewCheckpoint === checkpoint;
  }

  private markStartupReviewScheduled(checkpoint: string): void {
    if (!this.systemSessionId) return;
    this.deps.sessionManager.updateContext(this.systemSessionId, {
      startupCompletionReviewCheckpoint: checkpoint,
      startupCompletionReviewAt: new Date().toISOString(),
    });
  }

  private async reviewCompletedExecution(lifecycle: ExecutionLifecycleState): Promise<void> {
    if (!this.systemSessionId) return;
    const checkpoint = getStartupReviewCheckpoint(lifecycle);
    if (this.hasCompletedStartupReview(checkpoint)) {
      log.info('[SystemAgentManager] Startup completion review already processed', {
        sessionId: this.systemSessionId,
        checkpoint,
      });
      return;
    }

    const prompt = buildCompletedExecutionReviewPrompt(lifecycle);
    try {
      const result = await this.executeRuntimeWithTimeout('dispatch', {
        sourceAgentId: 'system-startup-review',
        targetAgentId: SYSTEM_AGENT_CONFIG.id,
        task: prompt,
        sessionId: this.systemSessionId,
        metadata: {
          source: 'system-startup-review',
          role: 'system',
          deliveryMode: 'direct',
          progressDelivery: { mode: 'silent' },
          recovery: {
            type: 'review_completed_execution',
            stage: lifecycle.stage,
            substage: lifecycle.substage,
            finishReason: lifecycle.finishReason,
            lastTransitionAt: lifecycle.lastTransitionAt,
            turnId: lifecycle.turnId,
            dispatchId: lifecycle.dispatchId,
          },
        },
        blocking: false,
      }) as { ok?: boolean; status?: string; dispatchId?: string; error?: string };

      this.markStartupReviewScheduled(checkpoint);
      log.info('[SystemAgentManager] Startup completion review dispatched', {
        sessionId: this.systemSessionId,
        finishReason: lifecycle.finishReason,
        status: result?.status ?? 'unknown',
        dispatchId: result?.dispatchId,
      });
    } catch (error) {
      log.error(
        '[SystemAgentManager] Failed to dispatch startup completion review',
        error instanceof Error ? error : new Error(String(error)),
        {
          sessionId: this.systemSessionId,
          finishReason: lifecycle.finishReason,
          checkpoint,
        },
      );
    }
  }

  private async tryResumeInterruptedKernelTurn(lifecycle: ExecutionLifecycleState): Promise<boolean> {
    if (!this.systemSessionId) return false;
    const finishReason = typeof lifecycle.finishReason === 'string'
      ? lifecycle.finishReason.trim().toLowerCase()
      : '';
    const substage = typeof lifecycle.substage === 'string'
      ? lifecycle.substage.trim().toLowerCase()
      : '';
    const isStopToolPending = substage === 'turn_stop_tool_pending';
    if (lifecycle.stage === 'completed' && finishReason === 'stop' && !isStopToolPending) return false;

    const snapshotPath = path.join(
      FINGER_PATHS.home,
      'system',
      'sessions',
      this.systemSessionId,
      'diagnostics',
      `${SYSTEM_AGENT_CONFIG.id}.prompt-injection.jsonl`,
    );

    log.info('[SystemAgentManager] Startup recovery decision (system)', {
      sessionId: this.systemSessionId,
      lifecycleStage: lifecycle.stage,
      lifecycleSubstage: lifecycle.substage ?? 'none',
      finishReason: lifecycle.finishReason ?? 'none',
      snapshotPath,
      stopToolPending: isStopToolPending,
    });

    try {
      await fs.access(snapshotPath);
    } catch {
      log.info('[SystemAgentManager] Hard recovery snapshot missing; falling back to prompt recovery', {
        sessionId: this.systemSessionId,
        snapshotPath,
      });
      return false;
    }

    try {
      const result = await this.executeRuntimeWithTimeout('dispatch', {
        sourceAgentId: 'system-recovery',
        targetAgentId: SYSTEM_AGENT_CONFIG.id,
        task: '[INTERNAL RECOVERY] Resume previous unfinished kernel turn from persisted snapshot.',
        sessionId: this.systemSessionId,
        metadata: {
          source: 'system-recovery',
          role: 'system',
          deliveryMode: 'direct',
          progressDelivery: { mode: 'silent' },
          resumeKernelTurnFile: snapshotPath,
          resumeKernelTurnHard: true,
          recovery: {
            type: 'resume_unfinished_kernel_turn',
            stage: lifecycle.stage,
            substage: lifecycle.substage,
            lastTransitionAt: lifecycle.lastTransitionAt,
            turnId: lifecycle.turnId,
            dispatchId: lifecycle.dispatchId,
            finishReason: lifecycle.finishReason,
          },
        },
        blocking: false,
      }) as { ok?: boolean; status?: string; dispatchId?: string; error?: string };

      log.info('[SystemAgentManager] Hard recovery dispatched from prompt snapshot', {
        sessionId: this.systemSessionId,
        lifecycleStage: lifecycle.stage,
        lifecycleSubstage: lifecycle.substage,
        finishReason: lifecycle.finishReason,
        status: result?.status ?? 'unknown',
        dispatchId: result?.dispatchId,
      });
      return true;
    } catch (error) {
      log.error(
        '[SystemAgentManager] Hard recovery dispatch failed; falling back to prompt recovery',
        error instanceof Error ? error : new Error(String(error)),
        {
          sessionId: this.systemSessionId,
          snapshotPath,
          lifecycleStage: lifecycle.stage,
          lifecycleSubstage: lifecycle.substage,
        },
      );
      return false;
    }
  }

  private async executeRuntimeWithTimeout<T>(
    action: string,
    payload: Record<string, unknown>,
    timeoutMs = SYSTEM_RUNTIME_EXEC_TIMEOUT_MS,
  ): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const timeoutError = new Error(`[SystemAgentManager] runtime execute timeout: ${action} after ${timeoutMs}ms`);
        (timeoutError as NodeJS.ErrnoException).code = 'SYSTEM_RUNTIME_EXEC_TIMEOUT';
        reject(timeoutError);
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.deps.agentRuntimeBlock.execute(action, payload) as Promise<T>,
        timeoutPromise,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  stop(): void {
    if (this.runner) {
      this.runner.stop();
      this.runner = null;
    }
    this.started = false;
  }

  private async resolvePeriodicCheckConfig(): Promise<{ enabled: boolean; intervalMs: number }> {
    const defaults = {
      // 默认关闭：避免与 HeartbeatScheduler 重复触发、导致空转与无意义唤醒。
      enabled: false,
      intervalMs: DEFAULT_PERIODIC_CHECK_INTERVAL_MS,
    };

    const fromOptions = this.options.periodicCheck;
    if (fromOptions) {
      return {
        enabled: fromOptions.enabled !== false,
        intervalMs: Number.isFinite(fromOptions.intervalMs)
          ? Math.max(1_000, Math.floor(fromOptions.intervalMs as number))
          : defaults.intervalMs,
      };
    }

    try {
      const raw = await fs.readFile(SYSTEM_AGENT_MANAGER_CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as SystemAgentManagerFileConfig;
      const intervalMs = parsed.periodicCheck?.intervalMs;
      return {
        enabled: parsed.periodicCheck?.enabled !== false,
        intervalMs: Number.isFinite(intervalMs)
          ? Math.max(1_000, Math.floor(intervalMs as number))
          : defaults.intervalMs,
      };
    } catch {
      return defaults;
    }
  }

  /**
   * 监控项目唯一真源：registry。
   * 不再从 sessions 自动导入并开启 monitored，避免“显示项目 A，实际检查项目 B”。
   */
  private async initializeRegistryFromSessions(): Promise<void> {
    try {
      const registry = await loadRegistry();
      log.info('[SystemAgentManager] Registry loaded (session auto-import disabled)', {
        projects: Object.keys(registry.agents).length,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error('[SystemAgentManager] Failed to initialize registry from sessions:', error);
    }
  }
}
