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
import { logger } from '../../core/logger.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { promises as fs } from 'fs';
import path from 'path';
import {
  getExecutionLifecycleState,
  type ExecutionLifecycleState,
} from './execution-lifecycle.js';

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

    // TODO: 实现启动 Orchestrator Agent 的逻辑
    // 这应该通过 AgentRuntimeBlock.execute('dispatch', {...}) 来实现
    // Agent 启动后会自动调用 system-registry-tool 注册自己

    // 临时占位：实际启动逻辑需要集成到 AgentRuntimeBlock
    log.info(`[TODO] Project Agent ${agentId} would be started here`);
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

    const prompt = this.buildInterruptedExecutionResumePrompt(lifecycle);
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

  private getStartupReviewCheckpoint(lifecycle: ExecutionLifecycleState): string {
    const stableTaskId = [
      lifecycle.messageId,
      lifecycle.startedAt,
      lifecycle.turnId,
      lifecycle.dispatchId,
    ].find((value) => typeof value === 'string' && value.trim().length > 0) ?? 'no-task-id';

    return [
      'startup-review',
      lifecycle.finishReason ?? 'none',
      stableTaskId,
    ].join('::');
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
    const checkpoint = this.getStartupReviewCheckpoint(lifecycle);
    if (this.hasCompletedStartupReview(checkpoint)) {
      log.info('[SystemAgentManager] Startup completion review already processed', {
        sessionId: this.systemSessionId,
        checkpoint,
      });
      return;
    }

    const prompt = this.buildCompletedExecutionReviewPrompt(lifecycle);
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

  private buildInterruptedExecutionResumePrompt(lifecycle: ExecutionLifecycleState): string {
    const lines = [
      '# Interrupted Execution Recovery',
      '',
      '系统刚刚重启。检测到你上一轮推理没有正常收口。',
      '你必须基于当前 session 历史与现有上下文，从中断处继续执行，而不是把它当成一个全新任务重新探索。',
      '',
      '## Recovery Snapshot',
      `- stage: ${lifecycle.stage}`,
      lifecycle.substage ? `- substage: ${lifecycle.substage}` : undefined,
      `- startedAt: ${lifecycle.startedAt}`,
      `- lastTransitionAt: ${lifecycle.lastTransitionAt}`,
      lifecycle.messageId ? `- messageId: ${lifecycle.messageId}` : undefined,
      lifecycle.dispatchId ? `- dispatchId: ${lifecycle.dispatchId}` : undefined,
      lifecycle.turnId ? `- turnId: ${lifecycle.turnId}` : undefined,
      lifecycle.toolName ? `- toolName: ${lifecycle.toolName}` : undefined,
      lifecycle.detail ? `- detail: ${lifecycle.detail}` : undefined,
      typeof lifecycle.retryCount === 'number' ? `- retryCount: ${lifecycle.retryCount}` : undefined,
      lifecycle.lastError ? `- lastError: ${lifecycle.lastError}` : undefined,
      '',
      '## Required Behavior',
      '1. 先检查最近一次未完成任务到底停在什么地方。',
      '2. 沿着原任务继续执行，优先完成闭环，不要从头做大范围重复探索。',
      '3. 如果你判断上次任务事实上已经完成，只是因为重启没有收口，那么立即输出总结并结束本轮。',
      '4. 如果恢复继续执行，请在正文里明确说明你是在“重启恢复后继续处理”。',
    ].filter((line): line is string => typeof line === 'string');

    return lines.join('\n');
  }

  private buildCompletedExecutionReviewPrompt(lifecycle: ExecutionLifecycleState): string {
    const lines = [
      '# Startup Delivery Review',
      '',
      '系统刚刚重启。检测到上一轮执行已经以 finish_reason=stop 收口。',
      '你现在必须先审查“上一轮是否真的完成了用户目标”，而不是默认任务已经完成。',
      '',
      '## Review Snapshot',
      `- stage: ${lifecycle.stage}`,
      lifecycle.substage ? `- substage: ${lifecycle.substage}` : undefined,
      `- finishReason: ${lifecycle.finishReason ?? 'unknown'}`,
      `- startedAt: ${lifecycle.startedAt}`,
      `- lastTransitionAt: ${lifecycle.lastTransitionAt}`,
      lifecycle.messageId ? `- messageId: ${lifecycle.messageId}` : undefined,
      lifecycle.dispatchId ? `- dispatchId: ${lifecycle.dispatchId}` : undefined,
      lifecycle.turnId ? `- turnId: ${lifecycle.turnId}` : undefined,
      lifecycle.detail ? `- detail: ${lifecycle.detail}` : undefined,
      '',
      '## Required Behavior',
      '1. 先基于当前 session 历史核对上一轮用户目标、你的最终交付、以及是否真的闭环完成。',
      '2. 如果上一轮只是“停止”了，但目标没有真正完成、回复不充分、还有明显下一步可执行，必须立即继续执行，不要等待用户再次催促。',
      '3. 只有当用户目标已经完成，并且当前没有安全可做的下一步时，才允许结束本轮。',
      '4. 除非涉及危险/不可逆/需要权限确认的决定，否则不要等待用户输入；应在确认方案后自动继续执行。',
      '5. 在任何“准备等待”或“准备停止”之前，再检查一次原始目标：如果还有安全明确的下一步，就先做下一步。',
      '6. 心跳执行顺序必须固定：先完成上一轮任务；若只是伪完成，继续做到真完成；真完成后才允许查看 heartbeat 文件。',
      '',
      '如果你判断上一轮已经完成，请输出最小化内部确认并结束；如果未完成，直接继续完成闭环。',
    ].filter((line): line is string => typeof line === 'string');

    return lines.join('\n');
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
