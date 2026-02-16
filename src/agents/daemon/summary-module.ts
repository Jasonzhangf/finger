import type { OutputModule } from '../../orchestration/module-registry.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import { Agent, AgentConfig } from '../agent.js';
import { SummaryRole } from "../roles/summary.js";
import { BdTools } from '../shared/bd-tools.js';

export interface SummaryModuleConfig {
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

export function createSummaryModule(
  config: SummaryModuleConfig,
  _hub: MessageHub
): { agent: Agent; module: OutputModule } {
  const agentConfig: AgentConfig = {
    id: config.id,
    name: config.name,
    mode: config.mode,
    provider: 'iflow',
    systemPrompt: config.systemPrompt ?? '你是一个总结 Agent，负责生成最终总结。',
    cwd: config.cwd,
  };

  const agent = new Agent(agentConfig);
  const bdTools = new BdTools();
  let initialized = false;
  const summaryRole = new SummaryRole(
    {
      id: config.id,
      systemPrompt: config.systemPrompt ?? '你是一个总结 Agent，负责生成最终总结。',
      provider: config.provider,
    },
    bdTools
  );

  const module: OutputModule = {
    id: config.id,
    type: 'output',
    name: config.name,
    version: '1.0.0',
    metadata: { mode: config.mode, provider: 'iflow', role: 'summary' },

    initialize: async () => {
      if (initialized) return;
      const status = await agent.initialize();
      console.log(`[SummaryModule ${config.id}] Initialized, session: ${status.sessionId}`);
      initialized = true;
    },

    destroy: async () => {
      await agent.disconnect();
      initialized = false;
    },

    handle: async (message: unknown, callback?: (result: unknown) => void) => {
      const msg = message as any;
      const { epicId, reviewOutput } = msg;

      if (!epicId) {
        const error = { success: false, error: 'Missing epicId' };
        if (callback) callback(error);
        return error;
      }

      try {
        const summaryResult = await summaryRole.summarize(epicId, reviewOutput);
        if (callback) callback({ success: true, result: summaryResult });
        return { success: true, result: summaryResult };
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
