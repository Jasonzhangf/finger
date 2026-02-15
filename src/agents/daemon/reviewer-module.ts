import type { OutputModule } from '../../orchestration/module-registry.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import { Agent, AgentConfig } from '../agent.js';
import { ReviewerRole, type ReviewerRoleConfig } from '../roles/reviewer.js';

export interface ReviewerModuleConfig {
  id: string;
  name: string;
  mode: 'auto' | 'manual';
  systemPrompt?: string;
  cwd?: string;
}

export function createReviewerModule(
  config: ReviewerModuleConfig,
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
  const reviewerRole = new ReviewerRole({
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
    metadata: { mode: config.mode, provider: 'iflow', role: 'reviewer' },

    initialize: async () => {
      if (initialized) return;
      await reviewerRole.initialize();
      initialized = true;
    },

    destroy: async () => {
      await reviewerRole.disconnect();
      initialized = false;
    },

    handle: async (message: unknown, callback?: (result: unknown) => void) => {
      const msg = message as Record<string, unknown>;
      const epicId = msg.epicId as string;
      const tasks = (msg.tasks as Array<{ id?: string; description: string }>) || [];
      const results = (msg.results as unknown[]) || [];

      if (!epicId) {
        const error = { success: false, error: 'Missing epicId' };
        if (callback) callback(error);
        return error;
      }

      try {
        const reviewResult = await reviewerRole.review(epicId, tasks, results);
        if (callback) callback({ success: true, result: reviewResult });
        return { success: true, result: reviewResult };
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
