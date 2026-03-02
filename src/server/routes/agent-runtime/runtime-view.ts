import type { Express } from 'express';
import type { AgentRuntimeRouteDeps, AgentCapabilityLayer } from './types.js';
import { resolveAgentCapabilityLayer } from './types.js';
import type { AgentControlRequest } from '../../modules/agent-runtime/types.js';
import { controlAgentRuntime } from '../../modules/agent-runtime/control.js';
import { dispatchTaskToAgent } from '../../modules/agent-runtime/dispatch.js';
import type { AgentDispatchRequest } from '../../modules/agent-runtime/types.js';
import { isObjectRecord } from '../../common/object.js';

export function registerRuntimeViewRoutes(app: Express, deps: AgentRuntimeRouteDeps): void {
  app.get('/api/v1/agents/runtime-view', (_req, res) => {
    void deps.getAgentRuntimeDeps().agentRuntimeBlock.execute('runtime_view', {}).then((snapshot) => {
      res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        ...(snapshot as Record<string, unknown>),
      });
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    });
  });

  app.get('/api/v1/agents/catalog', (req, res) => {
    const layer = resolveAgentCapabilityLayer(req.query.layer);
    void deps.getAgentRuntimeDeps().agentRuntimeBlock.execute('catalog', { layer }).then((result) => {
      res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        ...(result as Record<string, unknown>),
      });
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    });
  });

  app.get('/api/v1/agents/debug/mode', (_req, res) => {
    res.json({
      success: true,
      enabled: deps.runtimeDebug.get(),
      modules: deps.runtimeDebug.moduleIds.map((id) => ({
        id,
        active: Boolean(deps.moduleRegistry.getModule(id)),
      })),
    });
  });

  app.post('/api/v1/agents/debug/mode', async (req, res) => {
    const body = req.body as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      res.status(400).json({ success: false, error: 'enabled(boolean) is required' });
      return;
    }
    try {
      await deps.runtimeDebug.set(body.enabled);
      res.json({
        success: true,
        enabled: deps.runtimeDebug.get(),
        modules: deps.runtimeDebug.moduleIds.map((id) => ({
          id,
          active: Boolean(deps.moduleRegistry.getModule(id)),
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  app.get('/api/v1/agents/mock/policy', (_req, res) => {
    res.json({
      success: true,
      policy: deps.mockRuntime.rolePolicy,
      flags: deps.flags,
    });
  });

  app.post('/api/v1/agents/mock/policy', (req, res) => {
    const body = req.body as { executor?: string; reviewer?: string; searcher?: string };
    const policy = deps.mockRuntime.rolePolicy;
    if (body.executor === 'success' || body.executor === 'failure') policy.executor = body.executor;
    if (body.reviewer === 'success' || body.reviewer === 'failure') policy.reviewer = body.reviewer;
    if (body.searcher === 'success' || body.searcher === 'failure') policy.searcher = body.searcher;
    res.json({ success: true, policy });
  });

  app.get('/api/v1/agents/mock/assertions', (_req, res) => {
    const filters = { limit: 200 };
    res.json({ success: true, assertions: deps.mockRuntime.listAssertions(filters) });
  });

  app.delete('/api/v1/agents/mock/assertions', (_req, res) => {
    deps.mockRuntime.clearAssertions();
    res.json({ success: true, message: 'Mock assertions cleared' });
  });

  app.post('/api/v1/agents/dispatch', async (req, res) => {
    const runtimeDeps = deps.getAgentRuntimeDeps();
    const body = req.body as {
      targetAgentId?: string;
      task?: unknown;
      sessionId?: string;
      workflowId?: string;
      blocking?: boolean;
      metadata?: Record<string, unknown>;
    };

    if (typeof body.targetAgentId !== 'string' || body.targetAgentId.trim().length === 0) {
      res.status(400).json({ error: 'targetAgentId is required' });
      return;
    }

    const request: AgentControlRequest = {
      action: 'dispatch' as const,
      targetAgentId: body.targetAgentId.trim(),
      task: body.task,
      sessionId: body.sessionId,
      workflowId: body.workflowId,
      blocking: body.blocking ?? true,
      metadata: body.metadata,
    };

    const dispatchRequest: AgentDispatchRequest = {
      sourceAgentId: runtimeDeps.primaryOrchestratorAgentId,
      targetAgentId: body.targetAgentId.trim(),
      task: body.task,
      sessionId: body.sessionId,
      workflowId: body.workflowId,
      blocking: body.blocking ?? true,
      metadata: body.metadata,
    };
    const result = await dispatchTaskToAgent(runtimeDeps, dispatchRequest);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  });
}
