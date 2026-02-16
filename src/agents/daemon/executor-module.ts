import type { OutputModule } from '../../orchestration/module-registry.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import { Agent, AgentConfig } from '../agent.js';
import { ExecutorRole } from '../roles/executor.js';
import type { TaskAssignment } from '../protocol/schema.js';

export interface ExecutorModuleConfig {
  id: string;
  name: string;
  mode: 'auto' | 'manual';
  systemPrompt?: string;
  cwd?: string;
}

export function createExecutorModule(
  config: ExecutorModuleConfig,
  _hub: MessageHub
): { agent: Agent; module: OutputModule } {
  const agentConfig: AgentConfig = {
    id: config.id,
    name: config.name,
    mode: config.mode,
    provider: 'iflow',
    systemPrompt: config.systemPrompt,
    cwd: config.cwd,
  };

  const agent = new Agent(agentConfig);
  const executorRole = new ExecutorRole({
    id: config.id,
    name: config.name,
    mode: config.mode,
    systemPrompt: config.systemPrompt,
    cwd: config.cwd,
  });

  let initialized = false;

  const module: OutputModule = {
    id: config.id,
    type: 'output',
    name: config.name,
    version: '1.0.0',
    metadata: { mode: config.mode, provider: 'iflow', role: 'executor' },

    initialize: async () => {
      if (initialized) return;
      await executorRole.initialize();
      initialized = true;
    },

    destroy: async () => {
      await executorRole.disconnect();
      initialized = false;
    },

    handle: async (message: unknown, callback?: (result: unknown) => void) => {
      const msg = message as Record<string, unknown>;
      const task: TaskAssignment = {
        taskId: String(msg.taskId || msg.id || 'task-' + Date.now()),
        bdTaskId: msg.bdTaskId as string | undefined,
        description: String(msg.description || msg.task || msg.content || ''),
        tools: (msg.tools as string[]) || [],
        priority: (msg.priority as number) ?? 1,
        deadline: msg.deadline as number | undefined,
      };

      if (!task.description) {
        const error = { success: false, error: 'No task description provided' };
        if (callback) callback(error);
        return error;
      }

      try {
        const result = await executorRole.execute(task);
        if (callback) callback(result);
        return result;
      } catch (err) {
        const error = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
        if (callback) callback(error);
        return error;
      }
    },
  };

  return { agent, module };
}
