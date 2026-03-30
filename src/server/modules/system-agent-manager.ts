/**
 * System Agent Manager
 *
 * 在 daemon 中启动 System Agent 的定时检查任务
 */

import type { AgentRuntimeDeps } from './agent-runtime/types.js';
import { PeriodicCheckRunner } from '../../agents/finger-system-agent/periodic-check.js';
import { loadRegistry } from '../../agents/finger-system-agent/registry.js';
import type { AgentInfo } from '../../agents/finger-system-agent/registry.js';
import { SYSTEM_AGENT_CONFIG } from '../../agents/finger-system-agent/index.js';
import { FINGER_PROJECT_AGENT_ID, FINGER_REVIEWER_AGENT_ID } from '../../agents/finger-general/finger-general-module.js';
import { logger } from '../../core/logger.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { promises as fs } from 'fs';
import path from 'path';
import {
  getExecutionLifecycleState,
  type ExecutionLifecycleState,
} from './execution-lifecycle.js';
import {
  buildCompletedExecutionReviewPrompt,
  buildInterruptedExecutionResumePrompt,
  getStartupReviewCheckpoint,
} from './system-agent-manager-recovery.js';

const log = logger.module('SystemAgentManager');
const DEFAULT_PERIODIC_CHECK_INTERVAL_MS = 5 * 60_000;
const SYSTEM_AGENT_MANAGER_CONFIG_PATH = path.join(FINGER_PATHS.config.dir, 'system-agent-manager.json');
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

    // 4. 启动监控中的 Project Agents
    await this.startMonitoredProjects();

    // 4.5 恢复中断的 reviewer runtime sessions（若存在）
    await this.recoverReviewerSessionsIfNeeded();

    // 5. 启动后不再自动注入 bootstrap 开机检查（避免无意义负载与忙态干扰）。
    // 如需人工触发，可通过显式 dispatch/system 指令发起。
  }


  private async deploySystemAgent(): Promise<void> {
    try {
      const deployResult = await this.deps.agentRuntimeBlock.execute('deploy', {
        targetAgentId: SYSTEM_AGENT_CONFIG.id,
        sessionId: this.systemSessionId,
        instanceCount: 1,
        launchMode: 'orchestrator',
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

    log.info(`Starting Project Agent ${agentId} for ${projectId} at ${projectPath}`);
    const sessionId = this.resolveProjectSessionIdForRecovery(agent);
    const deployResult = await this.deps.agentRuntimeBlock.execute('deploy', {
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
    };
    const candidateFromRegistry = typeof agent.lastSessionId === 'string'
      ? sessionManager.getSession?.(agent.lastSessionId)
      : null;
    if (candidateFromRegistry
      && !this.deps.isRuntimeChildSession(candidateFromRegistry)
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
        .sort((a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime())[0]
      : undefined;
    if (latestRoot) return latestRoot.id;

    const createSession = sessionManager.createSession;
    if (typeof createSession === 'function') {
      const created = createSession.call(sessionManager, projectPath, agent.projectName, { allowReuse: true });
      if (created?.id) return created.id;
    }
    if (this.systemSessionId) return this.systemSessionId;
    return 'default';
  }

  private async resumeProjectSessionIfNeeded(agent: AgentInfo, sessionId: string): Promise<void> {
    const lifecycle = getExecutionLifecycleState(this.deps.sessionManager, sessionId);
    if (!lifecycle) {
      log.info('[SystemAgentManager] Monitored project has no lifecycle state; skip startup recovery', {
        projectId: agent.projectId,
        projectPath: agent.projectPath,
        sessionId,
      });
      return;
    }
    const staleCompletedReason = await this.detectStaleCompletedLifecycleForMonitoredProject(sessionId, lifecycle);
    if (!this.shouldResumeLifecycle(lifecycle) && !staleCompletedReason) {
      log.info('[SystemAgentManager] Monitored project lifecycle already completed; no recovery needed', {
        projectId: agent.projectId,
        projectPath: agent.projectPath,
        sessionId,
        stage: lifecycle.stage,
        finishReason: lifecycle.finishReason ?? 'none',
      });
      return;
    }

    const prompt = [
      staleCompletedReason
        ? `系统重启恢复：检测到该项目会话标记为 completed，但最近一轮出现异常（${staleCompletedReason}）。`
        : '系统重启恢复：检测到该项目会话上一轮未完成。',
      `项目路径：${agent.projectPath}`,
      `状态：${lifecycle.stage}${lifecycle.substage ? `/${lifecycle.substage}` : ''}`,
      '请从当前中断点继续执行，直到任务真正完成（finish_reason=stop）。',
    ].join('\n');

    const result = await this.deps.agentRuntimeBlock.execute('dispatch', {
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
          recovery: {
            type: 'resume_monitored_project_execution',
            stage: lifecycle.stage,
            substage: lifecycle.substage,
            finishReason: lifecycle.finishReason,
          lastTransitionAt: lifecycle.lastTransitionAt,
            turnId: lifecycle.turnId,
            dispatchId: lifecycle.dispatchId,
            ...(staleCompletedReason ? { staleCompletedReason } : {}),
          },
        },
        blocking: false,
      }) as { status?: string; dispatchId?: string; ok?: boolean; error?: string };

    log.info('[SystemAgentManager] Monitored project recovery dispatched', {
      projectId: agent.projectId,
      projectPath: agent.projectPath,
      sessionId,
      lifecycleStage: lifecycle.stage,
      lifecycleSubstage: lifecycle.substage,
      staleCompletedReason: staleCompletedReason ?? undefined,
      status: result?.status ?? 'unknown',
      dispatchId: result?.dispatchId,
      error: result?.ok === false ? (result.error ?? 'unknown') : undefined,
    });
  }

  private async detectStaleCompletedLifecycleForMonitoredProject(
    sessionId: string,
    lifecycle: ExecutionLifecycleState,
  ): Promise<string | null> {
    if (lifecycle.stage !== 'completed') return null;
    if (lifecycle.finishReason === 'stop') return null;

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
    } catch {
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
      } catch {
        // ignore malformed line
      }
    }
    return null;
  }

  private async recoverReviewerSessionsIfNeeded(): Promise<void> {
    const sessionManager = this.deps.sessionManager as {
      listSessions?: () => Array<{ id: string; projectPath: string; context?: Record<string, unknown> }>;
    };
    const listSessions = sessionManager.listSessions;
    if (typeof listSessions !== 'function') {
      log.debug('[SystemAgentManager] Session manager has no listSessions(); skip reviewer recovery');
      return;
    }
    const runtimeChildCheck = typeof this.deps.isRuntimeChildSession === 'function'
      ? this.deps.isRuntimeChildSession.bind(this.deps)
      : (() => false);
    const sessions = listSessions.call(sessionManager);
    const candidates = sessions.filter((session) => {
      if (!runtimeChildCheck(session)) return false;
      const context = (session.context && typeof session.context === 'object')
        ? (session.context as Record<string, unknown>)
        : {};
      return typeof context.ownerAgentId === 'string' && context.ownerAgentId.trim() === FINGER_REVIEWER_AGENT_ID;
    });

    if (candidates.length === 0) {
      log.info('[SystemAgentManager] No reviewer runtime sessions found for startup recovery');
      return;
    }

    for (const session of candidates) {
      const lifecycle = getExecutionLifecycleState(this.deps.sessionManager, session.id);
      if (!lifecycle) continue;
      if (!this.shouldResumeLifecycle(lifecycle)) continue;

      try {
        const deployResult = await this.deps.agentRuntimeBlock.execute('deploy', {
          targetAgentId: FINGER_REVIEWER_AGENT_ID,
          sessionId: session.id,
          instanceCount: 1,
          launchMode: 'orchestrator',
          scope: 'session',
          config: {
            enabled: true,
          },
        }) as { success?: boolean; deployment?: { id?: string; status?: string }; error?: string };

        if (!deployResult?.success) {
          log.warn('[SystemAgentManager] Failed to deploy reviewer runtime for recovery', {
            sessionId: session.id,
            projectPath: session.projectPath,
            error: deployResult?.error ?? 'unknown',
          });
          continue;
        }

        const prompt = [
          '系统重启恢复：检测到 reviewer 会话上一轮未完成。',
          `会话：${session.id}`,
          `状态：${lifecycle.stage}${lifecycle.substage ? `/${lifecycle.substage}` : ''}`,
          '请从当前中断点继续审查流程并给出明确 PASS/REJECT 行动。',
        ].join('\n');

        const result = await this.deps.agentRuntimeBlock.execute('dispatch', {
          sourceAgentId: 'system-reviewer-recovery',
          targetAgentId: FINGER_REVIEWER_AGENT_ID,
          task: prompt,
          sessionId: session.id,
          metadata: {
            source: 'system-reviewer-recovery',
            role: 'system',
            deliveryMode: 'direct',
            progressDelivery: { mode: 'silent' },
            recovery: {
              type: 'resume_reviewer_execution',
              stage: lifecycle.stage,
              substage: lifecycle.substage,
              finishReason: lifecycle.finishReason,
              lastTransitionAt: lifecycle.lastTransitionAt,
              turnId: lifecycle.turnId,
              dispatchId: lifecycle.dispatchId,
            },
          },
          blocking: false,
        }) as { status?: string; dispatchId?: string; ok?: boolean; error?: string };

        log.info('[SystemAgentManager] Reviewer recovery dispatched', {
          sessionId: session.id,
          projectPath: session.projectPath,
          lifecycleStage: lifecycle.stage,
          lifecycleSubstage: lifecycle.substage,
          status: result?.status ?? 'unknown',
          dispatchId: result?.dispatchId,
          error: result?.ok === false ? (result.error ?? 'unknown') : undefined,
        });
      } catch (error) {
        log.error(
          '[SystemAgentManager] Failed to recover reviewer session',
          error instanceof Error ? error : new Error(String(error)),
          { sessionId: session.id, projectPath: session.projectPath },
        );
      }
    }
  }

  private async handleStartupExecutionState(): Promise<void> {
    if (!this.systemSessionId) return;

    const lifecycle = getExecutionLifecycleState(this.deps.sessionManager, this.systemSessionId);
    if (!lifecycle) {
      log.info('[SystemAgentManager] No startup execution lifecycle found', {
        sessionId: this.systemSessionId,
        stage: 'none',
      });
      return;
    }

    if (this.shouldResumeLifecycle(lifecycle)) {
      await this.resumeInterruptedExecution(lifecycle);
      return;
    }

    if (this.shouldReviewCompletedLifecycle(lifecycle)) {
      await this.reviewCompletedExecution(lifecycle);
      return;
    }

    log.info('[SystemAgentManager] Startup execution state requires no action', {
      sessionId: this.systemSessionId,
      stage: lifecycle.stage,
      finishReason: lifecycle.finishReason ?? 'none',
    });
  }

  private shouldResumeLifecycle(lifecycle: ExecutionLifecycleState): boolean {
    if (lifecycle.finishReason === 'stop') return false;
    if (ACTIVE_LIFECYCLE_STAGES.has(lifecycle.stage)) return true;
    return lifecycle.stage === 'failed';
  }

  private shouldReviewCompletedLifecycle(lifecycle: ExecutionLifecycleState): boolean {
    return lifecycle.finishReason === 'stop';
  }

  private async resumeInterruptedExecution(lifecycle: ExecutionLifecycleState): Promise<void> {
    if (!this.systemSessionId) return;

    const hardRecovered = await this.tryResumeInterruptedKernelTurn(lifecycle);
    if (hardRecovered) {
      return;
    }

    const prompt = buildInterruptedExecutionResumePrompt(lifecycle);
    try {
      const result = await this.deps.agentRuntimeBlock.execute('dispatch', {
        sourceAgentId: 'system-recovery',
        targetAgentId: SYSTEM_AGENT_CONFIG.id,
        task: prompt,
        sessionId: this.systemSessionId,
        metadata: {
          source: 'system-recovery',
          role: 'system',
          deliveryMode: 'direct',
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
      const result = await this.deps.agentRuntimeBlock.execute('dispatch', {
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
    if (lifecycle.finishReason === 'stop') return false;

    const snapshotPath = path.join(
      FINGER_PATHS.home,
      'system',
      'sessions',
      this.systemSessionId,
      'diagnostics',
      `${SYSTEM_AGENT_CONFIG.id}.prompt-injection.jsonl`,
    );

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
      const result = await this.deps.agentRuntimeBlock.execute('dispatch', {
        sourceAgentId: 'system-recovery',
        targetAgentId: SYSTEM_AGENT_CONFIG.id,
        task: '[INTERNAL RECOVERY] Resume previous unfinished kernel turn from persisted snapshot.',
        sessionId: this.systemSessionId,
        metadata: {
          source: 'system-recovery',
          role: 'system',
          deliveryMode: 'direct',
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
