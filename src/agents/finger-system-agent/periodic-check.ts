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
import { updateAgentStatus, updateHeartbeat, listAgents } from './registry.js';

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
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<void> {
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
      await updateAgentStatus(registryEntry.projectId, status === 'idle' ? 'idle' : 'busy');
      await updateHeartbeat(registryEntry.projectId);

      // 仅对 idle agent 发送心跳提示词
      if (status === 'idle') {
        await this.sendHeartbeatPrompt(agentId, registryEntry.projectPath);
      }
    }
  }

  private async sendHeartbeatPrompt(agentId: string, projectPath: string): Promise<void> {
    const sessionStore = new SessionControlPlaneStore();
    const bindings = sessionStore.list({ agentId });
    const latest = bindings[0];

    if (!latest) return;

    await this.deps.agentRuntimeBlock.execute('dispatch', {
      targetAgentId: agentId,
      task: {
        prompt: `# Heartbeat Check\n\n请检查项目根目录的 HEARTBEAT.md 并执行待办任务。\n\n项目路径: ${projectPath}`,
      },
      sessionId: latest.fingerSessionId,
      metadata: {
        source: 'system-heartbeat',
        role: 'system',
      },
      blocking: false,
    });
  }
}
