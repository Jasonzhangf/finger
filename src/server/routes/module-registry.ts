import type { Express } from 'express';
import type { ModuleRegistry } from '../../orchestration/module-registry.js';

export interface ModuleRegistryRouteDeps {
  moduleRegistry: ModuleRegistry;
}

export function registerModuleRegistryRoutes(app: Express, deps: ModuleRegistryRouteDeps): void {
  const { moduleRegistry } = deps;

  app.post('/api/v1/module/register', async (req, res) => {
    const body = req.body as { filePath?: string };
    if (!body.filePath) {
      res.status(400).json({ error: 'Missing filePath' });
      return;
    }

    try {
      await moduleRegistry.loadFromFile(body.filePath);
      res.json({ success: true, message: `Module loaded from ${body.filePath}` });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: errorMessage });
    }
  });
}
