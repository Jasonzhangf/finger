import type { OutputModule } from '../../orchestration/module-registry.js';
import { Agent, AgentConfig } from '../agent.js';
import type { TaskResult } from '../agent.js';

export interface IflowAgentModuleConfig {
  id: string;
  name: string;
  mode: 'auto' | 'manual';
  systemPrompt?: string;
  allowedTools?: string[];
  cwd?: string;
}

/**
 * iFlow Agent output module for MessageHub
 */
export function createIflowAgentOutputModule(config: IflowAgentModuleConfig): {
  agent: Agent;
  module: OutputModule;
} {
  const agentConfig: AgentConfig = {
    id: config.id,
    name: config.name,
    mode: config.mode,
    provider: 'iflow',
    systemPrompt: config.systemPrompt,
    allowedTools: config.allowedTools,
    cwd: config.cwd,
  };

  const agent = new Agent(agentConfig);
  let initialized = false;

  const module: OutputModule = {
    id: config.id,
    type: 'output',
    name: config.name,
    version: '1.0.0',
    metadata: { mode: config.mode, provider: 'iflow' },

    initialize: async () => {
      if (initialized) return;
      const status = await agent.initialize();
      console.log(`[IflowAgentModule ${config.id}] Initialized, session: ${status.sessionId}`);
      initialized = true;
    },

    destroy: async () => {
      await agent.disconnect();
      initialized = false;
    },

    handle: async (message: unknown, callback?: (result: unknown) => void) => {
      const msg = message as Record<string, unknown>;
      const taskContent = typeof message === 'string'
        ? message
        : (msg.content ?? msg.task ?? msg.text ?? JSON.stringify(message));

      const result: TaskResult = await agent.execute(
        String(taskContent),
        undefined,
        msg.files as Array<{ path?: string; image?: string }> | undefined
      );

      const payload = {
        taskId: (msg.taskId ?? msg.id) as string | undefined,
        ...result,
      };

      if (callback) {
        callback(payload);
      }

      return payload;
    },
  };

  return { agent, module };
}
