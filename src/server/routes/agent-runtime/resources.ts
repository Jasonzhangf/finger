import type { Express } from 'express';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { FINGER_PATHS } from '../../../core/finger-paths.js';
import type { AgentRuntimeRouteDeps } from './types.js';

export function registerResourceRoutes(app: Express, deps: AgentRuntimeRouteDeps): void {
  app.get('/api/v1/agent/:agentId/progress', (req, res) => {
    const resource = deps.resourcePool.getAllResources().find((r) => r.id === req.params.agentId);
    if (!resource) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const executionLogPath = join(FINGER_PATHS.logs.dir, `${req.params.agentId}.jsonl`);
    let iterations: unknown[] = [];

    try {
      if (existsSync(executionLogPath)) {
        const content = readFileSync(executionLogPath, 'utf-8');
        iterations = content
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line))
          .slice(-50);
      }
    } catch {
      // Ignore errors
    }

    res.json({
      agentId: resource.id,
      status: resource.status,
      sessionId: resource.currentSessionId,
      workflowId: resource.currentWorkflowId,
      totalDeployments: resource.totalDeployments,
      iterations,
      lastDeployedAt: resource.deployedAt,
    });
  });

  app.get('/api/v1/resources', (_req, res) => {
    const available = deps.resourcePool.getAvailableResources();
    res.json({
      available: available.map((resource) => ({
        id: resource.id,
        name: resource.name || resource.id,
        type: resource.type,
        status: resource.status,
      })),
      count: available.length,
    });
  });

  app.post('/api/v1/resources/deploy', (req, res) => {
    const { resourceId, sessionId, workflowId } = req.body as {
      resourceId?: string;
      sessionId?: string;
      workflowId?: string;
    };

    if (!resourceId) {
      res.status(400).json({ error: 'Missing resourceId' });
      return;
    }

    const resource = deps.resourcePool.getAllResources().find((item) => item.id === resourceId);
    if (!resource) {
      res.status(409).json({ error: 'Resource not available or already deployed' });
      return;
    }

    const broadcast = deps.getAgentRuntimeDeps().broadcast;
    broadcast({
      type: 'resource_update',
      payload: { resourceId, status: resource.status, sessionId, workflowId },
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, resource });
  });

  app.post('/api/v1/resources/release', (req, res) => {
    const { resourceId } = req.body as { resourceId?: string };
    if (!resourceId) {
      res.status(400).json({ error: 'Missing resourceId' });
      return;
    }

    deps.resourcePool.releaseResource(resourceId);
    const resource = deps.resourcePool.getAllResources().find((item) => item.id === resourceId);
    if (!resource) {
      res.status(404).json({ error: 'Resource not found' });
      return;
    }

    const broadcast = deps.getAgentRuntimeDeps().broadcast;
    broadcast({
      type: 'resource_update',
      payload: { resourceId, status: resource.status },
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, resource });
  });
}
