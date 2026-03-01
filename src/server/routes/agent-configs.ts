import type { Express } from 'express';
import type { LoadedAgentConfig } from '../../runtime/agent-json-config.js';

export interface AgentConfigRouteDeps {
  getLoadedAgentConfigDir: () => string;
  getLoadedAgentConfigs: () => LoadedAgentConfig[];
  agentJsonSchema: Record<string, unknown>;
  reloadAgentJsonConfigs: (requestedDir?: string) => void;
}

export function registerAgentConfigRoutes(app: Express, deps: AgentConfigRouteDeps): void {
  const { getLoadedAgentConfigDir, getLoadedAgentConfigs, agentJsonSchema, reloadAgentJsonConfigs } = deps;

  app.get('/api/v1/agents/configs', (_req, res) => {
    const dir = getLoadedAgentConfigDir();
    const configs = getLoadedAgentConfigs();
    res.json({
      success: true,
      dir,
      schema: agentJsonSchema,
      agents: configs.map((item) => ({
        filePath: item.filePath,
        id: item.config.id,
        name: item.config.name,
        role: item.config.role,
        tools: item.config.tools ?? {},
      })),
    });
  });

  app.get('/api/v1/agents/configs/schema', (_req, res) => {
    res.json({ success: true, schema: agentJsonSchema });
  });

  app.post('/api/v1/agents/configs/reload', (req, res) => {
    const requestedDir = req.body?.dir;
    if (requestedDir !== undefined && typeof requestedDir !== 'string') {
      res.status(400).json({ error: 'dir must be string when provided' });
      return;
    }

    try {
      reloadAgentJsonConfigs(requestedDir || getLoadedAgentConfigDir());
      const configs = getLoadedAgentConfigs();
      res.json({
        success: true,
        dir: getLoadedAgentConfigDir(),
        count: configs.length,
        agents: configs.map((item) => ({
          filePath: item.filePath,
          id: item.config.id,
          role: item.config.role,
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });
}
