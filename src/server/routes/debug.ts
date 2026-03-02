import type { Express } from 'express';
import type { BlockRegistry } from '../../core/registry.js';

export interface DebugRouteDeps {
  registry: BlockRegistry;
}

export function registerDebugRoutes(app: Express, deps: DebugRouteDeps): void {
  const { registry } = deps;

  app.get('/api/test', (_req, res) => {
    res.json({ ok: true, message: 'Test route works' });
  });

  app.get('/api/test/:id/state/:key', (req, res) => {
    const block = registry.getBlock(req.params.id);
    if (!block) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }
    const state = block.getState();
    res.json({ [req.params.key]: (state.data as Record<string, unknown>)?.[req.params.key] });
  });

  app.post('/api/test/:id/state/:key', (req, res) => {
    const block = registry.getBlock(req.params.id);
    if (!block) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }
    res.json({ success: true });
  });
}
