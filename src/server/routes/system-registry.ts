import type { Express } from 'express';
import { listAgents, setMonitorStatus } from '../../agents/finger-system-agent/registry.js';

export function registerSystemRegistryRoutes(app: Express): void {
  app.get('/api/v1/system/registry', (_req, res) => {
    void listAgents().then((agents) => {
      res.json({ success: true, agents });
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    });
  });

  app.post('/api/v1/system/registry/monitor', (req, res) => {
    const projectPath = typeof req.body?.projectPath === 'string' ? req.body.projectPath.trim() : '';
    const enabled = req.body?.enabled;

    if (!projectPath) {
      res.status(400).json({ success: false, error: 'projectPath is required' });
      return;
    }
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, error: 'enabled(boolean) is required' });
      return;
    }

    void setMonitorStatus(projectPath, enabled).then((agent) => {
      res.json({ success: true, agent });
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ success: false, error: message });
    });
  });
}
