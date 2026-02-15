import type { OutputModule } from '../../orchestration/module-registry.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import { Agent, AgentConfig } from '../agent.js';
import { SelfReviewRole, SelfReviewConfig } from '../roles/self-review.js';
import { BdTools } from '../shared/bd-tools.js';

export interface SelfReviewModuleConfig {
  id: string;
  name: string;
  mode: 'auto' | 'manual';
  systemPrompt?: string;
  cwd?: string;
  provider: {
    baseUrl: string;
    apiKey: string;
    defaultModel: string;
  };
}

export function createSelfReviewModule(
  config: SelfReviewModuleConfig,
  _hub: MessageHub
): { agent: Agent; module: OutputModule } {
  const agentConfig: AgentConfig = {
    id: config.id,
    name: config.name,
    mode: config.mode,
    provider: 'iflow',
    systemPrompt: config.systemPrompt ?? '你是一个自审 Agent，负责审查任务执行质量。',
    cwd: config.cwd,
  };

  const agent = new Agent(agentConfig);
  const bdTools = new BdTools();
  let initialized = false;
  const reviewRole = new SelfReviewRole(
    {
      id: config.id,
      systemPrompt: config.systemPrompt ?? '你是一个自审 Agent，负责审查任务执行质量。',
      provider: config.provider,
    },
    bdTools
  );

  const module: OutputModule = {
    id: config.id,
    type: 'output',
    name: config.name,
    version: '1.0.0',
    metadata: { mode: config.mode, provider: 'iflow', role: 'self-review' },

    initialize: async () => {
      if (initialized) return;
      const status = await agent.initialize();
      console.log(`[SelfReviewModule ${config.id}] Initialized, session: ${status.sessionId}`);
      initialized = true;
    },

    destroy: async () => {
      await agent.disconnect();
      initialized = false;
    },

    handle: async (message: unknown, callback?: (result: unknown) => void) => {
      const msg = message as any;
      const { epicId, tasks, results } = msg;

      if (!epicId || !tasks) {
        const error = { success: false, error: 'Missing epicId or tasks' };
        if (callback) callback(error);
        return error;
      }

      try {
        const reviewResult = await reviewRole.review(epicId, tasks, results);
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
