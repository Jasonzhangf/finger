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

const log = logger.module('SystemAgentManager');
const DEFAULT_PERIODIC_CHECK_INTERVAL_MS = 5 * 60_000;
const SYSTEM_AGENT_MANAGER_CONFIG_PATH = path.join(FINGER_PATHS.config.dir, 'system-agent-manager.json');

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
    
    // 2. 部署 System Agent（确保它持续运行）
    await this.deploySystemAgent();
    
    
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
