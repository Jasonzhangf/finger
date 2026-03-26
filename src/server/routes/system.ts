import type { Express } from 'express';
import { extname } from 'path';
import { statSync } from 'fs';
import type { BlockRegistry } from '../../core/registry.js';
import {
  loadUserSettings,
  saveUserSettings,
  type ContextBuilderSettings,
} from '../../core/user-settings.js';

export interface SystemRouteDeps {
  registry: BlockRegistry;
  localImageMimeByExt: Record<string, string>;
  listKernelProviders: () => unknown;
  upsertKernelProvider: (input: {
    id: string;
    name?: string;
    baseUrl?: string;
    wireApi?: string;
    envKey?: string;
    model?: string;
    select?: boolean;
  }) => unknown;
  selectKernelProvider: (providerId: string) => unknown;
  testKernelProvider: (providerId: string) => Promise<unknown>;
}

export function registerSystemRoutes(app: Express, deps: SystemRouteDeps): void {
  const {
    registry,
    localImageMimeByExt,
    listKernelProviders,
    upsertKernelProvider,
    selectKernelProvider,
    testKernelProvider,
  } = deps;

  app.get('/health', (_req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  app.get('/api/v1/providers', (_req, res) => {
    res.json(listKernelProviders());
  });

  app.post('/api/v1/providers/upsert', (req, res) => {
    const body = req.body as {
      id?: string;
      name?: string;
      baseUrl?: string;
      wireApi?: string;
      envKey?: string;
      model?: string;
      select?: boolean;
    };
    if (typeof body.id !== 'string' || body.id.trim().length === 0) {
      res.status(400).json({ error: 'provider id is required' });
      return;
    }
    try {
      const provider = upsertKernelProvider({
        id: body.id,
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.baseUrl === 'string' ? { baseUrl: body.baseUrl } : {}),
        ...(typeof body.wireApi === 'string' ? { wireApi: body.wireApi } : {}),
        ...(typeof body.envKey === 'string' ? { envKey: body.envKey } : {}),
        ...(typeof body.model === 'string' ? { model: body.model } : {}),
        ...(typeof body.select === 'boolean' ? { select: body.select } : {}),
      });
      res.json({ success: true, provider });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/v1/providers/:providerId/select', (req, res) => {
    const providerId = req.params.providerId;
    if (!providerId || providerId.trim().length === 0) {
      res.status(400).json({ error: 'providerId is required' });
      return;
    }
    try {
      const provider = selectKernelProvider(providerId);
      res.json({ success: true, provider });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/v1/providers/:providerId/test', async (req, res) => {
    const providerId = req.params.providerId;
    if (!providerId || providerId.trim().length === 0) {
      res.status(400).json({ error: 'providerId is required' });
      return;
    }
    try {
      const result = await testKernelProvider(providerId);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ success: false, message });
    }
  });

  app.get('/api/v1/context-builder/settings', (_req, res) => {
    try {
      const settings = loadUserSettings();
      res.json({
        success: true,
        settings: settings.contextBuilder,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  app.put('/api/v1/context-builder/settings', (req, res) => {
    const body = req.body as { settings?: Partial<ContextBuilderSettings> };
    const patch = body?.settings;
    if (!patch || typeof patch !== 'object') {
      res.status(400).json({ success: false, error: 'settings object is required' });
      return;
    }

    const validationErrors: string[] = [];
    const validModes: Array<ContextBuilderSettings['mode']> = ['minimal', 'moderate', 'aggressive'];
    const validRankingModes: Array<ContextBuilderSettings['enableModelRanking']> = [true, false, 'dryrun'];

    const settings = loadUserSettings();
    const current = settings.contextBuilder;
    const next: ContextBuilderSettings = { ...current };

    if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
      if (typeof patch.enabled !== 'boolean') validationErrors.push('enabled must be boolean');
      else next.enabled = patch.enabled;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'mode')) {
      if (typeof patch.mode !== 'string' || !validModes.includes(patch.mode as ContextBuilderSettings['mode'])) {
        validationErrors.push('mode must be one of: minimal | moderate | aggressive');
      } else {
        next.mode = patch.mode as ContextBuilderSettings['mode'];
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'historyBudgetTokens')) {
      if (typeof patch.historyBudgetTokens !== 'number' || patch.historyBudgetTokens <= 0) {
        validationErrors.push('historyBudgetTokens must be a positive number');
      } else {
        next.historyBudgetTokens = Math.floor(patch.historyBudgetTokens);
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'budgetRatio')) {
      if (typeof patch.budgetRatio !== 'number' || patch.budgetRatio <= 0 || patch.budgetRatio > 1) {
        validationErrors.push('budgetRatio must be number in (0, 1]');
      } else {
        next.budgetRatio = patch.budgetRatio;
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'halfLifeMs')) {
      if (typeof patch.halfLifeMs !== 'number' || patch.halfLifeMs <= 0) {
        validationErrors.push('halfLifeMs must be positive number');
      } else {
        next.halfLifeMs = patch.halfLifeMs;
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'overThresholdRelevance')) {
      if (typeof patch.overThresholdRelevance !== 'number' || patch.overThresholdRelevance < 0 || patch.overThresholdRelevance > 1) {
        validationErrors.push('overThresholdRelevance must be number in [0, 1]');
      } else {
        next.overThresholdRelevance = patch.overThresholdRelevance;
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'enableModelRanking')) {
      if (!validRankingModes.includes(patch.enableModelRanking as ContextBuilderSettings['enableModelRanking'])) {
        validationErrors.push("enableModelRanking must be true | false | 'dryrun'");
      } else {
        next.enableModelRanking = patch.enableModelRanking as ContextBuilderSettings['enableModelRanking'];
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'rankingProviderId')) {
      if (typeof patch.rankingProviderId !== 'string') validationErrors.push('rankingProviderId must be string');
      else next.rankingProviderId = patch.rankingProviderId;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'includeMemoryMd')) {
      if (typeof patch.includeMemoryMd !== 'boolean') validationErrors.push('includeMemoryMd must be boolean');
      else next.includeMemoryMd = false;
    }

    if (validationErrors.length > 0) {
      res.status(400).json({
        success: false,
        error: validationErrors.join('; '),
      });
      return;
    }

    settings.contextBuilder = next;
    saveUserSettings(settings);
    res.json({
      success: true,
      settings: settings.contextBuilder,
    });
  });

  app.get('/api/v1/files/local-image', (req, res) => {
    const rawPath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    if (rawPath.length === 0) {
      res.status(400).json({ error: 'query.path is required' });
      return;
    }

    const mimeType = localImageMimeByExt[extname(rawPath).toLowerCase()];
    if (!mimeType) {
      res.status(415).json({ error: 'unsupported image extension' });
      return;
    }

    const stat = statSync(rawPath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) {
      res.status(404).json({ error: 'file not found' });
      return;
    }

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.sendFile(rawPath, (error) => {
      if (!error || res.headersSent) return;
      res.status(500).json({ error: `failed to read image: ${error.message}` });
    });
  });

  app.get('/api/blocks', (_req, res) => {
    res.json(registry.generateApiEndpoints());
  });

  app.get('/api/blocks/:id/state', (req, res) => {
    const block = registry.getBlock(req.params.id);
    if (!block) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }
    res.json(block.getState());
  });

  app.post('/api/blocks/:id/:command', async (req, res) => {
    const { id, command } = req.params;
    const block = registry.getBlock(id);
    if (!block) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }
    try {
      const result = await registry.execute(id, command, req.body ?? {});
      res.json({ success: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ success: false, error: message });
    }
  });
}
