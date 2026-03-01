import type { Express } from 'express';
import type { AskManager } from '../../orchestration/ask/ask-manager.js';
import type { WorkflowManager } from '../../orchestration/workflow-manager.js';
import type { runtimeInstructionBus as RuntimeInstructionBusType } from '../../orchestration/runtime-instruction-bus.js';

type RuntimeInstructionBus = typeof RuntimeInstructionBusType;

export interface WorkflowRouteDeps {
  workflowManager: WorkflowManager;
  askManager: AskManager;
  runtimeInstructionBus: RuntimeInstructionBus;
  broadcast: (message: Record<string, unknown>) => void;
  primaryOrchestratorAgentId: string;
}

export function registerWorkflowRoutes(app: Express, deps: WorkflowRouteDeps): void {
  const { workflowManager, askManager, runtimeInstructionBus, broadcast, primaryOrchestratorAgentId } = deps;

  app.get('/api/v1/workflows', (_req, res) => {
    const workflows = workflowManager.listWorkflows();
    res.json(workflows.map((workflow) => ({
      id: workflow.id,
      sessionId: workflow.sessionId,
      epicId: workflow.epicId,
      status: workflow.status,
      taskCount: workflow.tasks.size,
      completedTasks: Array.from(workflow.tasks.values()).filter((t) => t.status === 'completed').length,
      failedTasks: Array.from(workflow.tasks.values()).filter((t) => t.status === 'failed').length,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
      userTask: workflow.userTask,
    })));
  });

  app.get('/api/v1/workflows/:id', (req, res) => {
    const workflow = workflowManager.getWorkflow(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    const tasks = Array.from(workflow.tasks.values());
    res.json({
      id: workflow.id,
      sessionId: workflow.sessionId,
      epicId: workflow.epicId,
      status: workflow.status,
      taskCount: workflow.tasks.size,
      completedTasks: tasks.filter((t) => t.status === 'completed').length,
      failedTasks: tasks.filter((t) => t.status === 'failed').length,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
      userTask: workflow.userTask,
    });
  });

  app.get('/api/v1/workflows/:id/tasks', (req, res) => {
    const workflow = workflowManager.getWorkflow(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    const tasks = Array.from(workflow.tasks.values());
    res.json(tasks);
  });

  app.post('/api/v1/workflow/pause', (req, res) => {
    const { workflowId, hard } = req.body as { workflowId?: string; hard?: boolean };
    if (!workflowId) {
      res.status(400).json({ error: 'Missing workflowId' });
      return;
    }
    const workflow = workflowManager.getWorkflow(workflowId);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    workflowManager.pauseWorkflow(workflowId, hard);

    broadcast({
      type: 'workflow_update',
      payload: { workflowId, status: 'paused' },
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, workflowId, status: 'paused' });
  });

  app.post('/api/v1/workflow/resume', (req, res) => {
    const { workflowId } = req.body as { workflowId?: string };
    if (!workflowId) {
      res.status(400).json({ error: 'Missing workflowId' });
      return;
    }
    const workflow = workflowManager.getWorkflow(workflowId);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    workflowManager.resumeWorkflow(workflowId);

    broadcast({
      type: 'workflow_update',
      payload: { workflowId, status: 'executing' },
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, workflowId, status: 'executing' });
  });

  app.post('/api/v1/workflow/input', (req, res) => {
    const { workflowId, input } = req.body as { workflowId?: string; input?: unknown };
    if (!workflowId || input === undefined) {
      res.status(400).json({ error: 'Missing workflowId or input' });
      return;
    }
    const workflow = workflowManager.getWorkflow(workflowId);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    const askResolution = askManager.resolveOldestByScope({
      agentId: primaryOrchestratorAgentId,
      workflowId: String(workflowId),
      ...(typeof workflow.epicId === 'string' && workflow.epicId.trim().length > 0 ? { epicId: workflow.epicId.trim() } : {}),
      ...(typeof workflow.sessionId === 'string' && workflow.sessionId.trim().length > 0 ? { sessionId: workflow.sessionId.trim() } : {}),
    }, String(input));

    if (askResolution) {
      res.json({ success: true, workflowId, askResolution });
      return;
    }

    workflowManager.updateWorkflowContext(workflowId, { lastUserInput: input });
    runtimeInstructionBus.push(workflowId, String(input));

    const workflowEpicId = workflow.epicId;
    if (workflowEpicId) {
      runtimeInstructionBus.push(workflowEpicId, String(input));
    }

    broadcast({
      type: 'workflow_update',
      payload: { workflowId, userInput: input },
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, workflowId });
  });
}
