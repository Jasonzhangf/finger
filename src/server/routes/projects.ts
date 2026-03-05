import type { Express } from 'express';
import type { BlockRegistry } from '../../core/registry.js';

export interface ProjectRouteDeps {
  registry: BlockRegistry;
}

export function registerProjectRoutes(app: Express, deps: ProjectRouteDeps): void {
  app.post('/api/v1/projects/pick-directory', async (req, res) => {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : undefined;
    try {
      const result = await deps.registry.execute('project-1', 'pick-directory', { prompt });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });
}
