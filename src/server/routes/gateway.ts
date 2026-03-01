import type { Express } from 'express';
import type { MessageHub } from '../../orchestration/message-hub.js';
import type { ModuleRegistry } from '../../orchestration/module-registry.js';
import type { GatewayManager } from '../../gateway/gateway-manager.js';

export interface GatewayRouteDeps {
  hub: MessageHub;
  moduleRegistry: ModuleRegistry;
  gatewayManager: GatewayManager;
}

export function registerGatewayRoutes(app: Express, deps: GatewayRouteDeps): void {
  const { hub, moduleRegistry, gatewayManager } = deps;

  app.get('/api/v1/modules', (_req, res) => {
    res.json({
      inputs: hub.getInputs().map((input) => ({ id: input.id, routes: input.routes })),
      outputs: hub.getOutputs().map((output) => ({ id: output.id })),
      modules: moduleRegistry.getAllModules().map((module) => ({ id: module.id, type: module.type, name: module.name })),
    });
  });

  app.get('/api/v1/routes', (_req, res) => {
    res.json({ routes: hub.getRoutes() });
  });

  app.get('/api/v1/gateways', (_req, res) => {
    res.json({
      success: true,
      gateways: gatewayManager.list(),
    });
  });

  app.get('/api/v1/gateways/:id', (req, res) => {
    const gateway = gatewayManager.inspect(req.params.id);
    if (!gateway) {
      res.status(404).json({ error: `Gateway not found: ${req.params.id}` });
      return;
    }

    res.json({
      success: true,
      gateway: {
        ...gateway.manifest,
        modulePath: gateway.modulePath,
        moduleDir: gateway.moduleDir,
        readmePath: gateway.readmePath,
        cliDocPath: gateway.cliDocPath,
        readmeExcerpt: gateway.readmeExcerpt,
        cliDocExcerpt: gateway.cliDocExcerpt,
      },
    });
  });

  app.get('/api/v1/gateways/:id/probe', (req, res) => {
    const probe = gatewayManager.probe(req.params.id);
    if (!probe) {
      res.status(404).json({ error: `Gateway not found: ${req.params.id}` });
      return;
    }
    res.json({ success: true, probe });
  });

  app.post('/api/v1/gateways/register', async (req, res) => {
    const gatewayPath = req.body?.path;
    if (typeof gatewayPath !== 'string' || gatewayPath.trim().length === 0) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    try {
      const installed = await gatewayManager.registerFromPath(gatewayPath);
      res.json({
        success: true,
        gateway: {
          id: installed.manifest.id,
          modulePath: installed.modulePath,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/v1/gateways/reload', async (_req, res) => {
    try {
      await gatewayManager.reload();
      res.json({ success: true, gateways: gatewayManager.list() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.delete('/api/v1/gateways/:id', async (req, res) => {
    try {
      const removed = await gatewayManager.unregister(req.params.id);
      if (!removed) {
        res.status(404).json({ error: `Gateway not found: ${req.params.id}` });
        return;
      }
      res.json({ success: true, id: req.params.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/v1/gateways/:id/input', async (req, res) => {
    const body = req.body as {
      message?: unknown;
      target?: string;
      blocking?: boolean;
      sender?: string;
    };
    if (body.message === undefined) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    try {
      const result = await gatewayManager.dispatchInput(req.params.id, {
        message: body.message,
        target: typeof body.target === 'string' ? body.target : undefined,
        sender: typeof body.sender === 'string' ? body.sender : undefined,
        blocking: body.blocking === true,
      });
      res.json({ success: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });
}
