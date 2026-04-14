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
import {
  updateTeamAgentStatus,
  updateRuntimeStatus,
  type RuntimeStatus,
} from '../../common/team-status-state.js';
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
  
  /**
   * 立即执行一次 periodic check（用于启动时立即启动 monitored agents）
   */
  runOnceImmediately(): Promise<void> {
    return this.runOnce();
  }
  
  /**
   * 启动 Project Agent（用于 monitored agents 启动）
   */
  private async startProjectAgent(agent: { agentId: string; projectPath: string; projectId: string }): Promise<void> {
    try {
      const deployResult = await this.deps.agentRuntimeBlock.execute('deploy', {
        targetAgentId: 'finger-project-agent',
        sessionId: `hb-session-${agent.agentId}-${agent.projectPath.replace(/[^a-zA-Z0-9]/g, '-')}`,
        instanceCount: 1,
        launchMode: 'orchestrator',
        scope: 'session',
        config: {
          enabled: true,
        },
      }) as { success?: boolean; deployment?: { id?: string; status?: string }; error?: string };
      
      if (deployResult?.success) {
        clog.log(`[PeriodicCheckRunner] Project Agent deployed: ${agent.agentId}`, {
          deploymentId: deployResult.deployment?.id,
          deploymentStatus: deployResult.deployment?.status,
        });
      } else {
        clog.error(`[PeriodicCheckRunner] Failed to deploy Project Agent: ${agent.agentId}`, {
          error: deployResult?.error,
        });
      }
    } catch (error) {
      clog.error(`[PeriodicCheckRunner] Error starting Project Agent: ${agent.agentId}`, error);
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
    
    // 1. 启动未运行的 monitored agents
    const runningAgentIds = new Set(agents.map((a: any) => a.id as string));
    const monitoredAgents = registryAgents.filter(a => a.monitored === true);
    
    for (const agent of monitoredAgents) {
      if (!runningAgentIds.has(agent.agentId)) {
        clog.log(`[PeriodicCheckRunner] Starting monitored agent: ${agent.agentId}`);
        await this.startProjectAgent(agent);
      }
    }

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

      // 同步 runtimeStatus 到 team.status
      // 先确保 agent 存在于 team.status store
      updateTeamAgentStatus(agentId, {
        agentId,
        projectPath: registryEntry.projectPath,
        projectId: registryEntry.projectId,
      });
      // 更新 runtimeStatus（从 runtime_view 获取）
      const runtimeStatus = status as RuntimeStatus;
      const lastEvent = agent.lastEvent;
      updateRuntimeStatus({
        agentId,
        runtimeStatus,
        lastDispatchId: lastEvent?.dispatchId,
        lastTaskId: lastEvent?.taskId,
        lastTaskName: lastEvent?.summary,
      });
      emitAgentStatusChanged(this.deps, { agentId, status: nextStatus, projectId: registryEntry.projectId });

      // 仅对 idle + monitored agent 发送心跳提示词（监控路径以 registry 为真源）
      if (status === 'idle' && registryEntry.monitored === true) {
        await this.sendHeartbeatPrompt(agentId, registryEntry.projectPath);
      }
    }
  }

  private async sendHeartbeatPrompt(agentId: string, projectPath: string): Promise<void> {
    const sessionStore = new SessionControlPlaneStore();
    const sessionManager = (this.deps as { sessionManager?: unknown }).sessionManager as {
      getSession?: (sessionId: string) => unknown;
      getOrCreateSystemSession?: () => { id?: string };
    } | undefined;
    const getSession = (sessionManager as {
      getSession?: (sessionId: string) => unknown;
    } | undefined)?.getSession;
    if (agentId === 'finger-system-agent' && sessionManager && typeof sessionManager.getOrCreateSystemSession === 'function') {
      const systemSession = sessionManager.getOrCreateSystemSession();
      const systemSessionId = typeof systemSession?.id === 'string' ? systemSession.id.trim() : '';
      if (systemSessionId.length > 0) {
        try {
          sessionStore.set(systemSessionId, agentId, 'finger', systemSessionId, { source: 'periodic-check-system-session' });
        } catch (error) {
          clog.error('[PeriodicCheckRunner] Failed to persist system session binding:', error);
        }
        const prompt = `# Heartbeat Check\n\n请检查项目根目录的 HEARTBEAT.md 并执行待办任务。\n\n项目路径: ${projectPath}`;
        await this.deps.agentRuntimeBlock.execute('dispatch', {
          sourceAgentId: 'system-heartbeat',
          targetAgentId: agentId,
          task: prompt,
          sessionId: systemSessionId,
          queueOnBusy: false,
          maxQueueWaitMs: 0,
          metadata: {
            source: 'system-heartbeat',
            role: 'system',
            systemDirectInject: true,
            deliveryMode: 'direct',
          },
          blocking: false,
        });
        return;
      }
    }

    const bindings = sessionStore.list({ agentId, provider: 'finger' });
    const latest = bindings.find((binding) => (
      typeof getSession === 'function' ? !!getSession.call(sessionManager, binding.fingerSessionId) : true
    ))
      ?? bindings[0];
    if (!latest) return;

    let sessionId = latest.fingerSessionId;
    const hasSession = typeof getSession === 'function'
      ? !!getSession.call(sessionManager, sessionId)
      : true;
    if (!hasSession && agentId === 'finger-system-agent') {
      const getSystemSession = (sessionManager as any)?.getOrCreateSystemSession;
      if (typeof getSystemSession === 'function') {
        const systemSession = getSystemSession.call(sessionManager);
        if (systemSession?.id && typeof systemSession.id === 'string') {
          sessionId = systemSession.id;
          try {
            sessionStore.set(sessionId, agentId, 'finger', sessionId, { source: 'periodic-check-self-heal' });
          } catch (error) {
            clog.error('[PeriodicCheckRunner] Failed to heal session binding:', error);
          }
        }
      }
    }
    const hasResolvedSession = typeof getSession === 'function'
      ? !!getSession.call(sessionManager, sessionId)
      : true;
    if (!hasResolvedSession) return;

    const prompt = `# Heartbeat Check\n\n请检查项目根目录的 HEARTBEAT.md 并执行待办任务。\n\n项目路径: ${projectPath}`;

    await this.deps.agentRuntimeBlock.execute('dispatch', {
      sourceAgentId: 'system-heartbeat',
      targetAgentId: agentId,
      task: prompt,
      sessionId,
      queueOnBusy: false,
      maxQueueWaitMs: 0,
      metadata: {
        source: 'system-heartbeat',
        role: 'system',
        systemDirectInject: true,
        deliveryMode: 'direct',
      },
      blocking: false,
    });
  }
}
