/**
 * System Agent Manager
 *
 * 在 daemon 中启动 System Agent 的定时检查任务
 */

import type { AgentRuntimeDeps } from './agent-runtime/types.js';
import { PeriodicCheckRunner } from '../../agents/finger-system-agent/periodic-check.js';
import { loadRegistry } from '../../agents/finger-system-agent/registry.js';
import type { AgentInfo } from '../../agents/finger-system-agent/registry.js';
import { injectSkillsIntoPrompt } from '../../skills/skill-prompt-injector.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { SYSTEM_AGENT_CONFIG, SYSTEM_PROJECT_PATH } from '../../agents/finger-system-agent/index.js';
import { logger } from '../../core/logger.js';

const log = logger.module('SystemAgentManager');

export class SystemAgentManager {
  private runner: PeriodicCheckRunner | null = null;
  private systemSessionId: string | null = null;

  constructor(private deps: AgentRuntimeDeps) {}

  async start(): Promise<void> {
    if (this.runner) return;
    
    // 1. 创建或获取 System Agent 的 session
    this.systemSessionId = await this.ensureSystemSession();
    
    // 2. 部署 System Agent（确保它持续运行）
    await this.deploySystemAgent();
    
    
    // 3. 启动定时器
    this.runner = new PeriodicCheckRunner(this.deps);
    this.runner.start();

    // 4. 启动监控中的 Project Agents
    await this.startMonitoredProjects();

    // 5. 向 System Agent 注入启动 bootstrap 提示词
    await this.injectSystemBootstrap();
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

  private async injectSystemBootstrap(): Promise<void> {
    log.info('[SystemAgentManager] Checking System Agent deployment', {
      agentId: SYSTEM_AGENT_CONFIG.id
    });

    if (!this.systemSessionId) {
      log.warn('System session not available, skipping bootstrap injection');
      return;
    }

    try {
      const bootstrapPath = join(FINGER_PATHS.home, 'system', 'BOOTSTRAP.md');
      let bootstrapPrompt = '';

      try {
        bootstrapPrompt = readFileSync(bootstrapPath, 'utf-8');

        // Inject Skills into bootstrap prompt
        bootstrapPrompt = await injectSkillsIntoPrompt(bootstrapPrompt);

      log.info('[SystemAgentManager] Injecting bootstrap', {
        sessionId: this.systemSessionId,
        bootstrapPromptLength: bootstrapPrompt.length
      });
      } catch (err) {
        log.warn(`Bootstrap file not found at ${bootstrapPath}, using default prompt`);
        bootstrapPrompt = '你已经启动，请进行开机检查。';
      }

      if (bootstrapPrompt.trim().length === 0) {
        log.warn('Bootstrap prompt is empty, skipping injection');
        return;
      }

      // 使用正确的 sessionId 发送 bootstrap 提示词
      const dispatchResult: { ok: boolean; dispatchId?: string; error?: string } = 
        await this.deps.agentRuntimeBlock.execute('dispatch', {
          sourceAgentId: 'system-bootstrap',  // System bootstrap injection
          targetAgentId: SYSTEM_AGENT_CONFIG.id,
          task: bootstrapPrompt,
          sessionId: this.systemSessionId,
          metadata: {
            source: 'system-bootstrap',
            role: 'system',
          },
          blocking: false,
        }) as unknown as { ok: boolean; dispatchId?: string; error?: string };

      if (dispatchResult.ok) {
        log.info('[SystemAgentManager] Bootstrap injected successfully', { dispatchId: dispatchResult.dispatchId });
      } else {
        log.error('Failed to inject bootstrap:', dispatchResult.error ? new Error(dispatchResult.error) : undefined);
      }
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
