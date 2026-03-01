import type { Express } from 'express';
import { extname } from 'path';
import { statSync } from 'fs';
import type { BlockRegistry } from '../../core/registry.js';

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
