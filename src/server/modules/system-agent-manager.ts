/**
 * System Agent Manager
 *
 * 在 daemon 中启动 System Agent 的定时检查任务
 */

import type { AgentRuntimeDeps } from './agent-runtime/types.js';
import { PeriodicCheckRunner } from '../../agents/finger-system-agent/periodic-check.js';
import { loadRegistry } from '../../agents/finger-system-agent/registry.js';
import type { AgentInfo } from '../../agents/finger-system-agent/registry.js';
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
