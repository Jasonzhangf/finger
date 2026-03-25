/**
 * System Agent Periodic Check
 *
 * 每 5 分钟执行一次定时检查：
 * - 查询 AgentRuntimeBlock 状态
 * - 向 idle agents 发送心跳提示词
 * - 更新 registry.json
 */

import type { AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';
import { SessionControlPlaneStore } from '../../runtime/session-control-plane.js';
import { updateAgentStatus, listAgents } from './registry.js';
import { emitAgentStatusChanged } from './system-events.js';
import { createConsoleLikeLogger } from '../../core/logger/console-like.js';

const clog = createConsoleLikeLogger('PeriodicCheck');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface PeriodicCheckConfig {
  intervalMs?: number;
}

export class PeriodicCheckRunner {
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number;

  constructor(
    private deps: AgentRuntimeDeps,
    config: PeriodicCheckConfig = {}
  ) {
    this.intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    clog.log(`[PeriodicCheckRunner] Started with interval ${this.intervalMs}ms`);
    this.timer = setInterval(async () => {
      try {
        await this.runOnce();
      } catch (error) {
        clog.error('[PeriodicCheckRunner] Error in runOnce:', error);
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<void> {
    clog.log(`[PeriodicCheckRunner] Running periodic check...`);
    const runtimeView = await this.deps.agentRuntimeBlock.execute('runtime_view', {});
    const agents = Array.isArray((runtimeView as any).agents)
      ? (runtimeView as any).agents
      : [];

    const registryAgents = await listAgents();
    const registryByAgentId = new Map(registryAgents.map(a => [a.agentId, a]));

    for (const agent of agents) {
      const agentId = agent.id as string;
      const status = agent.status as string;

      const registryEntry = registryByAgentId.get(agentId);
      if (!registryEntry) {
        continue;
      }

      // 更新 registry 状态
      const nextStatus = status === 'idle' ? 'idle' : 'busy';
      await updateAgentStatus(registryEntry.projectId, nextStatus);
      emitAgentStatusChanged(this.deps, { agentId, status: nextStatus, projectId: registryEntry.projectId });

      // 仅对 idle + monitored agent 发送心跳提示词（监控路径以 registry 为真源）
      if (status === 'idle' && registryEntry.monitored === true) {
        await this.sendHeartbeatPrompt(agentId, registryEntry.projectPath);
      }
    }
  }

  private async sendHeartbeatPrompt(agentId: string, projectPath: string): Promise<void> {
    const sessionStore = new SessionControlPlaneStore();
    const bindings = sessionStore.list({ agentId });
    const latest = bindings[0];

    if (!latest) return;

    const prompt = `# Heartbeat Check\n\n请检查项目根目录的 HEARTBEAT.md 并执行待办任务。\n\n项目路径: ${projectPath}`;

    await this.deps.agentRuntimeBlock.execute('dispatch', {
      sourceAgentId: 'system-heartbeat',
      targetAgentId: agentId,
      task: prompt,
      sessionId: latest.fingerSessionId,
      metadata: {
        source: 'system-heartbeat',
        role: 'system',
      },
      blocking: false,
    });
  }
}
