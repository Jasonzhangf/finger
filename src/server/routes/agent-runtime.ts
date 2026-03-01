import type { Express } from 'express';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ModuleRegistry } from '../../orchestration/module-registry.js';
import type { ResourcePool } from '../../orchestration/resource-pool.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { isObjectRecord } from '../common/object.js';
import type { AgentControlRequest, AgentDispatchRequest, AgentRuntimeDeps } from '../modules/agent-runtime/types.js';
import { controlAgentRuntime } from '../modules/agent-runtime/control.js';
import { dispatchTaskToAgent } from '../modules/agent-runtime/dispatch.js';

type MockOutcome = 'success' | 'failure';
type MockRole = 'executor' | 'reviewer' | 'searcher';

export interface AgentRuntimeRouteDeps {
  getAgentRuntimeDeps: () => AgentRuntimeDeps;
  moduleRegistry: ModuleRegistry;
  resourcePool: ResourcePool;
  runtimeDebug: {
    get: () => boolean;
    set: (enabled: boolean) => Promise<void>;
    moduleIds: readonly string[];
  };
  mockRuntime: {
    rolePolicy: Record<MockRole, MockOutcome>;
    clearAssertions: () => void;
    listAssertions: (filters: {
      agentId?: string;
      workflowId?: string;
      sessionId?: string;
      limit?: number;
    }) => unknown[];
  };
  flags: {
    enableFullMockMode: boolean;
    useMockExecutorLoop: boolean;
    useMockReviewerLoop: boolean;
    useMockSearcherLoop: boolean;
  };
}

type AgentCapabilityLayer = 'summary' | 'execution' | 'governance' | 'full';

function resolveAgentCapabilityLayer(value: unknown): AgentCapabilityLayer {
  if (typeof value !== 'string') return 'summary';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'execution') return 'execution';
  if (normalized === 'governance') return 'governance';
  if (normalized === 'full') return 'full';
  return 'summary';
}

export function registerAgentRuntimeRoutes(app: Express, deps: AgentRuntimeRouteDeps): void {
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

  app.get('/api/v1/agents/debug/mock-policy', (_req, res) => {
    res.json({
      success: true,
      fullMockMode: deps.flags.enableFullMockMode,
      useMockExecutorRole: deps.flags.useMockExecutorLoop,
      useMockReviewerRole: deps.flags.useMockReviewerLoop,
      useMockSearcherRole: deps.flags.useMockSearcherLoop,
      useMockExecutorLoop: deps.flags.useMockExecutorLoop,
      useMockReviewerLoop: deps.flags.useMockReviewerLoop,
      useMockSearcherLoop: deps.flags.useMockSearcherLoop,
      policy: deps.mockRuntime.rolePolicy,
    });
  });

  app.post('/api/v1/agents/debug/mock-policy', (req, res) => {
    const body = req.body as { role?: string; outcome?: string };
    const roleRaw = typeof body.role === 'string' ? body.role.trim().toLowerCase() : '';
    const outcomeRaw = typeof body.outcome === 'string' ? body.outcome.trim().toLowerCase() : '';
    const isValidOutcome = outcomeRaw === 'success' || outcomeRaw === 'failure';
    if (!isValidOutcome) {
      res.status(400).json({ success: false, error: 'outcome must be success|failure' });
      return;
    }
    const outcome = outcomeRaw as MockOutcome;

    if (roleRaw === 'all') {
      deps.mockRuntime.rolePolicy.executor = outcome;
      deps.mockRuntime.rolePolicy.reviewer = outcome;
      deps.mockRuntime.rolePolicy.searcher = outcome;
    } else if (roleRaw === 'executor' || roleRaw === 'reviewer' || roleRaw === 'searcher') {
      deps.mockRuntime.rolePolicy[roleRaw] = outcome;
    } else {
      res.status(400).json({ success: false, error: 'role must be executor|reviewer|searcher|all' });
      return;
    }

    res.json({ success: true, policy: deps.mockRuntime.rolePolicy });
  });

  app.post('/api/v1/agents/debug/assertions/clear', (_req, res) => {
    deps.mockRuntime.clearAssertions();
    res.json({ success: true, count: 0 });
  });

  app.get('/api/v1/agents/debug/assertions', (req, res) => {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';
    const workflowId = typeof req.query.workflowId === 'string' ? req.query.workflowId.trim() : '';
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : '';
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 100;

    const filtered = deps.mockRuntime.listAssertions({
      agentId,
      workflowId,
      sessionId,
      limit,
    });

    res.json({
      success: true,
      debugMode: deps.runtimeDebug.get(),
      count: filtered.length,
      assertions: filtered,
    });
  });

  app.get('/api/v1/agents/ask/pending', (req, res) => {
    const runtimeDeps = deps.getAgentRuntimeDeps();
    const requestId = typeof req.query.requestId === 'string' ? req.query.requestId.trim() : '';
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';
    const workflowId = typeof req.query.workflowId === 'string' ? req.query.workflowId.trim() : '';
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : '';
    const epicId = typeof req.query.epicId === 'string' ? req.query.epicId.trim() : '';
    const pending = runtimeDeps.askManager.listPending({
      ...(requestId ? { requestId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(workflowId ? { workflowId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(epicId ? { epicId } : {}),
    });
    res.json({ success: true, count: pending.length, pending });
  });

  app.post('/api/v1/agents/ask/respond', (req, res) => {
    const runtimeDeps = deps.getAgentRuntimeDeps();
    const body = req.body as {
      requestId?: string;
      agentId?: string;
      answer?: string;
      workflowId?: string;
      sessionId?: string;
      epicId?: string;
    };
    const answer = typeof body.answer === 'string' ? body.answer : '';
    if (answer.trim().length === 0) {
      res.status(400).json({ success: false, error: 'answer is required' });
      return;
    }

    let resolved = typeof body.requestId === 'string' && body.requestId.trim().length > 0
      ? runtimeDeps.askManager.resolveByRequestId(body.requestId.trim(), answer)
      : null;
    if (!resolved) {
      if (!(typeof body.agentId === 'string' && body.agentId.trim().length > 0)
        && !(typeof body.workflowId === 'string' && body.workflowId.trim().length > 0)) {
        res.status(400).json({ success: false, error: 'requestId or (agentId + scope) is required' });
        return;
      }
      resolved = runtimeDeps.askManager.resolveOldestByScope({
        ...(typeof body.agentId === 'string' && body.agentId.trim().length > 0 ? { agentId: body.agentId.trim() } : {}),
        ...(typeof body.workflowId === 'string' && body.workflowId.trim().length > 0 ? { workflowId: body.workflowId.trim() } : {}),
        ...(typeof body.sessionId === 'string' && body.sessionId.trim().length > 0 ? { sessionId: body.sessionId.trim() } : {}),
        ...(typeof body.epicId === 'string' && body.epicId.trim().length > 0 ? { epicId: body.epicId.trim() } : {}),
      }, answer);
    }
    if (!resolved) {
      res.status(404).json({ success: false, error: 'pending ask request not found' });
      return;
    }
    res.json({ success: true, resolution: resolved });
  });

  app.post('/api/v1/agents/dispatch', async (req, res) => {
    const runtimeDeps = deps.getAgentRuntimeDeps();
    const body = req.body as {
      sourceAgentId?: string;
      targetAgentId?: string;
      task?: unknown;
      sessionId?: string;
      workflowId?: string;
      blocking?: boolean;
      queueOnBusy?: boolean;
      maxQueueWaitMs?: number;
      assignment?: AgentDispatchRequest['assignment'];
      metadata?: Record<string, unknown>;
    };

    if (typeof body.targetAgentId !== 'string' || body.targetAgentId.trim().length === 0) {
      res.status(400).json({ error: 'targetAgentId is required' });
      return;
    }
    if (body.task === undefined) {
      res.status(400).json({ error: 'task is required' });
      return;
    }

    const dispatchInput: AgentDispatchRequest = {
      sourceAgentId: typeof body.sourceAgentId === 'string' && body.sourceAgentId.trim().length > 0
        ? body.sourceAgentId.trim()
        : runtimeDeps.primaryOrchestratorAgentId,
      targetAgentId: body.targetAgentId.trim(),
      task: body.task,
      ...(typeof body.sessionId === 'string' && body.sessionId.trim().length > 0 ? { sessionId: body.sessionId.trim() } : {}),
      ...(typeof body.workflowId === 'string' && body.workflowId.trim().length > 0 ? { workflowId: body.workflowId.trim() } : {}),
      blocking: body.blocking === true,
      queueOnBusy: body.queueOnBusy !== false,
      ...(typeof body.maxQueueWaitMs === 'number' && Number.isFinite(body.maxQueueWaitMs)
        ? { maxQueueWaitMs: Math.max(1_000, Math.floor(body.maxQueueWaitMs)) }
        : {}),
      ...(isObjectRecord(body.assignment) ? { assignment: body.assignment } : {}),
      ...(isObjectRecord(body.metadata) ? { metadata: body.metadata } : {}),
    };

    const result = await dispatchTaskToAgent(runtimeDeps, dispatchInput);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  });

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
      res.status(400).json({ success: false, error: message });
    }
  });

  app.get('/api/v1/agents/stats', (_req, res) => {
    void deps.getAgentRuntimeDeps().agentRuntimeBlock.execute('runtime_view', {}).then((raw) => {
      const snapshot = raw as { agents?: Array<{ id: string; name: string; type: string; status: string }> };
      const stats = (snapshot.agents ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        status: item.status,
        load: 0,
        errorRate: 0,
        requestCount: 0,
        tokenUsage: 0,
        workTime: 0,
      }));
      res.json(stats);
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
    if (!resourceId || !sessionId || !workflowId) {
      res.status(400).json({ error: 'Missing resourceId, sessionId, or workflowId' });
      return;
    }

    deps.resourcePool.deployResource(resourceId, sessionId, workflowId);
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
