import type { Express } from 'express';
import type { AgentRuntimeRouteDeps } from './types.js';
import type { AgentControlRequest } from '../../modules/agent-runtime/types.js';
import { controlAgentRuntime } from '../../modules/agent-runtime/control.js';
import { isObjectRecord } from '../../common/object.js';

export function registerAgentOpsRoutes(app: Express, deps: AgentRuntimeRouteDeps): void {
  app.post('/api/v1/agents/control', async (req, res) => {
    const runtimeDeps = deps.getAgentRuntimeDeps();
    const body = req.body as {
      action?: string;
      targetAgentId?: string;
      sessionId?: string;
      workflowId?: string;
      providerId?: string;
      hard?: boolean;
    };
    if (typeof body.action !== 'string' || body.action.trim().length === 0) {
      res.status(400).json({ error: 'action is required' });
      return;
    }
    const action = body.action.trim().toLowerCase();
    if (action !== 'status' && action !== 'pause' && action !== 'resume' && action !== 'interrupt' && action !== 'cancel') {
      res.status(400).json({ error: 'action must be status|pause|resume|interrupt|cancel' });
      return;
    }

    const request: AgentControlRequest = {
      action: action as AgentControlRequest['action'],
      ...(typeof body.targetAgentId === 'string' && body.targetAgentId.trim().length > 0
        ? { targetAgentId: body.targetAgentId.trim() }
        : {}),
      ...(typeof body.sessionId === 'string' && body.sessionId.trim().length > 0
        ? { sessionId: body.sessionId.trim() }
        : {}),
      ...(typeof body.workflowId === 'string' && body.workflowId.trim().length > 0
        ? { workflowId: body.workflowId.trim() }
        : {}),
      ...(typeof body.providerId === 'string' && body.providerId.trim().length > 0
        ? { providerId: body.providerId.trim() }
        : {}),
      ...(typeof body.hard === 'boolean' ? { hard: body.hard } : {}),
    };

    const result = await controlAgentRuntime(runtimeDeps, request);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  });

  app.get('/api/v1/agents', (_req, res) => {
    void deps.getAgentRuntimeDeps().agentRuntimeBlock.execute('runtime_view', {}).then((raw) => {
      const snapshot = raw as { instances?: Array<{
        id: string;
        agentId: string;
        name: string;
        type: 'executor' | 'reviewer' | 'orchestrator' | 'searcher';
        status: 'idle' | 'running' | 'error' | 'paused' | 'queued' | 'waiting_input' | 'completed' | 'failed' | 'interrupted';
        sessionId?: string;
        workflowId?: string;
      }> };
      const instances = snapshot.instances ?? [];
      res.json(instances.map((item) => ({
        id: item.agentId,
        type: item.type,
        name: item.name,
        status: item.status,
        sessionId: item.sessionId,
        workflowId: item.workflowId,
        totalDeployments: 1,
      })));
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    });
  });

  app.post('/api/v1/agents/deploy', async (req, res) => {
    const body = req.body as {
      sessionId?: string;
      config?: Record<string, unknown>;
      scope?: 'session' | 'global';
      instanceCount?: number;
      targetAgentId?: string;
      targetImplementationId?: string;
      launchMode?: 'manual' | 'orchestrator';
    };

    try {
      const result = await deps.getAgentRuntimeDeps().agentRuntimeBlock.execute('deploy', {
        ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
        ...(isObjectRecord(body.config) ? { config: body.config } : {}),
        ...(body.scope ? { scope: body.scope } : {}),
        ...(Number.isFinite(body.instanceCount) ? { instanceCount: body.instanceCount } : {}),
        ...(typeof body.targetAgentId === 'string' ? { targetAgentId: body.targetAgentId } : {}),
        ...(typeof body.targetImplementationId === 'string' ? { targetImplementationId: body.targetImplementationId } : {}),
        ...(body.launchMode ? { launchMode: body.launchMode } : {}),
      });
      res.json({ success: true, ...(result as Record<string, unknown>) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  app.post('/api/v1/agents/:agentId/interrupt', async (req, res) => {
    const runtimeDeps = deps.getAgentRuntimeDeps();
    const request: AgentControlRequest = {
      action: 'interrupt',
      targetAgentId: req.params.agentId,
      hard: req.body.hard === true,
    };
    const result = await controlAgentRuntime(runtimeDeps, request);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  });

  app.post('/api/v1/agents/:agentId/cancel', async (req, res) => {
    const runtimeDeps = deps.getAgentRuntimeDeps();
    const request: AgentControlRequest = {
      action: 'cancel',
      targetAgentId: req.params.agentId,
    };
    const result = await controlAgentRuntime(runtimeDeps, request);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  });

  app.get('/api/v1/agents/:id', (req, res) => {
    void deps.getAgentRuntimeDeps().agentRuntimeBlock.execute('runtime_view', {}).then((raw) => {
      const snapshot = raw as { agents?: Array<{ id: string; name: string; type: string; status: string }> };
      const agent = (snapshot.agents ?? []).find((item) => item.id === req.params.id);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.json(agent);
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    });
  });

  app.get('/api/v1/agents/:id/stats', (req, res) => {
    void deps.getAgentRuntimeDeps().agentRuntimeBlock.execute('runtime_view', {}).then((raw) => {
      const snapshot = raw as { agents?: Array<{ id: string; name: string; type: string; status: string }> };
      const agent = (snapshot.agents ?? []).find((item) => item.id === req.params.id);
      if (!agent) {
        res.status(404).json({ error: 'Agent deployment not found' });
        return;
      }
      res.json({
        id: agent.id,
        name: agent.name,
        type: agent.type,
        status: agent.status,
        load: 0,
        errorRate: 0,
        requestCount: 0,
        tokenUsage: 0,
        workTime: 0,
      });
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    });
  });
}
