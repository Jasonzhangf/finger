import type { Express } from 'express';
import type { OrchestrationConfigV1 } from '../../orchestration/orchestration-config.js';
import {
  loadOrchestrationConfig,
  saveOrchestrationConfig,
} from '../../orchestration/orchestration-config.js';

export interface OrchestrationRouteDeps {
  applyOrchestrationConfig: (config: OrchestrationConfigV1) => Promise<{
    applied: number;
    agents: string[];
    profileId: string;
  }>;
  primaryOrchestratorAgentId: string;
  getChatCodexRunnerMode: () => 'mock' | 'real';
}

export function registerOrchestrationRoutes(app: Express, deps: OrchestrationRouteDeps): void {
  const { applyOrchestrationConfig, primaryOrchestratorAgentId, getChatCodexRunnerMode } = deps;

  app.get('/api/v1/orchestration/config', (_req, res) => {
    try {
      const loaded = loadOrchestrationConfig();
      res.json({
        success: true,
        path: loaded.path,
        created: loaded.created,
        config: loaded.config,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ success: false, error: message });
    }
  });

  app.put('/api/v1/orchestration/config', async (req, res) => {
    try {
      const saved = saveOrchestrationConfig(req.body);
      const applied = await applyOrchestrationConfig(saved.config);
      res.json({
        success: true,
        path: saved.path,
        config: saved.config,
        applied,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ success: false, error: message });
    }
  });

  app.post('/api/v1/orchestration/config/switch', async (req, res) => {
    const body = req.body as { profileId?: unknown };
    const profileId = typeof body.profileId === 'string' ? body.profileId.trim() : '';
    if (!profileId) {
      res.status(400).json({ success: false, error: 'profileId is required' });
      return;
    }
    try {
      const loaded = loadOrchestrationConfig();
      const switched = saveOrchestrationConfig({
        ...loaded.config,
        activeProfileId: profileId,
      });
      const applied = await applyOrchestrationConfig(switched.config);
      res.json({
        success: true,
        path: switched.path,
        config: switched.config,
        applied,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ success: false, error: message });
    }
  });

  app.get('/api/v1/orchestrator/runtime-mode', (_req, res) => {
    res.json({
      success: true,
      mode: 'finger-general-runner',
      fsmV2Implemented: true,
      runnerModuleId: primaryOrchestratorAgentId,
      chatCodexRunnerMode: getChatCodexRunnerMode(),
      updatedAt: new Date().toISOString(),
    });
  });
}
