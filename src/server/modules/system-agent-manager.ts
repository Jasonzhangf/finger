/**
 * System Agent Manager
 *
 * 在 daemon 中启动 System Agent 的定时检查任务
 */

import type { AgentRuntimeDeps } from './agent-runtime/types.js';
import { PeriodicCheckRunner } from '../../agents/finger-system-agent/periodic-check.js';
import { loadRegistry } from '../../agents/finger-system-agent/registry.js';
import type { AgentInfo } from '../../agents/finger-system-agent/registry.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { SYSTEM_AGENT_CONFIG } from '../../agents/finger-system-agent/index.js';
import { logger } from '../../core/logger.js';

const log = logger.module('SystemAgentManager');

export class SystemAgentManager {
  private runner: PeriodicCheckRunner | null = null;

  constructor(private deps: AgentRuntimeDeps) {}

  async start(): Promise<void> {
    if (this.runner) return;
    this.runner = new PeriodicCheckRunner(this.deps);
    this.runner.start();

    // 启动监控中的 Project Agents
    await this.startMonitoredProjects();

    // 向 System Agent 注入启动 bootstrap 提示词
    await this.injectSystemBootstrap();
  }

  private async injectSystemBootstrap(): Promise<void> {
    try {
      const bootstrapPath = join(FINGER_PATHS.home, 'system', 'BOOTSTRAP.md');
      let bootstrapPrompt = '';

      try {
        bootstrapPrompt = readFileSync(bootstrapPath, 'utf-8');
      } catch (err) {
        log.warn(`Bootstrap file not found at ${bootstrapPath}, using default prompt`);
        bootstrapPrompt = '你已经启动，请进行开机检查。';
      }

      if (bootstrapPrompt.trim().length === 0) {
        log.warn('Bootstrap prompt is empty, skipping injection');
        return;
      }

      // 查找或创建 system agent session
      const sessionResult = await this.deps.agentRuntimeBlock.execute('dispatch', {
        targetAgentId: SYSTEM_AGENT_CONFIG.id,
        task: {
          prompt: bootstrapPrompt,
        },
        sessionId: '', // 使用空 session ID 创建新会话
        metadata: {
          source: 'system-bootstrap',
          role: 'system',
        },
        blocking: false,
      });

      log.info('Injected system bootstrap prompt');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error('Failed to inject system bootstrap:', error);
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
    if (!this.runner) return;
    this.runner.stop();
    this.runner = null;
  }
}
