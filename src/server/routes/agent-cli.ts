import type { Express } from 'express';
import {
  understandCommand,
  routeCommand,
  planCommand,
  executeCommand,
  reviewCommand,
  orchestrateCommand,
} from '../../cli/agent-commands.js';
import { getOrCreateWorkflowFSM } from '../../orchestration/workflow-fsm.js';
import { ModuleRegistry } from '../../orchestration/module-registry.js';

export function registerAgentCliRoutes(app: Express): void {
  // API: 语义理解
  app.post('/api/v1/agent/understand', async (req, res) => {
    const { input, sessionId } = req.body;
    if (!input) {
      res.status(400).json({ error: 'Missing input' });
      return;
    }

    try {
      const result = await understandCommand(input, { sessionId });
      res.json({ success: true, result });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // API: 路由决策
  app.post('/api/v1/agent/route', async (req, res) => {
    const { input } = req.body;
    if (!input) {
      res.status(400).json({ error: 'Missing input' });
      return;
    }

    try {
      const result = await routeCommand(input);
      res.json({ success: true, result });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // API: 任务规划
  app.post('/api/v1/agent/plan', async (req, res) => {
    const { task, sessionId } = req.body;
    if (!task) {
      res.status(400).json({ error: 'Missing task' });
      return;
    }

    try {
      const result = await planCommand(task, { sessionId });
      res.json({ success: true, result });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // API: 任务执行
  app.post('/api/v1/agent/execute', async (req, res) => {
    const { task, agent, blocking, sessionId } = req.body;
    if (!task) {
      res.status(400).json({ error: 'Missing task' });
      return;
    }

    try {
      const result = await executeCommand(task, { agent, blocking, sessionId });
      res.json({ success: true, result });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // API: 质量审查
  app.post('/api/v1/agent/review', async (req, res) => {
    const { proposal } = req.body;
    if (!proposal) {
      res.status(400).json({ error: 'Missing proposal' });
      return;
    }

    try {
      const result = await reviewCommand(JSON.stringify(proposal));
      res.json({ success: true, result });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // API: 编排协调
  app.post('/api/v1/agent/orchestrate', async (req, res) => {
    const { task, sessionId, watch } = req.body;
    if (!task) {
      res.status(400).json({ error: 'Missing task' });
      return;
    }

    try {
      if (watch) {
        await orchestrateCommand(task, { sessionId, watch: true });
        res.json({ success: true, message: 'Orchestration started, streaming via WebSocket' });
      } else {
        const result = await orchestrateCommand(task, { sessionId });
        res.json({ success: true, result });
      }
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // API: 触发状态转换
  app.post('/api/v1/workflow/:workflowId/transition', async (req, res) => {
    const { workflowId } = req.params;
    const { trigger, context } = req.body;

    if (!trigger) {
      res.status(400).json({ error: 'Missing trigger' });
      return;
    }

    try {
      const fsm = getOrCreateWorkflowFSM({
        workflowId,
        sessionId: req.body.sessionId || workflowId,
      });

      const success = await fsm.trigger(trigger as any, context);

      if (!success) {
        res.status(400).json({ error: 'Transition failed', trigger, currentState: fsm.getState() });
        return;
      }

      res.json({
        success: true,
        currentState: fsm.getState(),
        context: fsm.getContext(),
      });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // API: Execute agent command (agent + command + params)
  app.post('/api/v1/agent/execute-command', async (req, res) => {
    const { agent, command, params } = req.body;
    if (!agent || !command) {
      res.status(400).json({ error: 'Missing agent or command' });
      return;
    }

    try {
      const globalRegistry = (global as any).__moduleRegistry || new ModuleRegistry((global as any).__messageHub);
      const modules = globalRegistry.getModulesByType('agent');
      const agentModule: any = modules.find((m: any) => m.id === agent);

      if (!agentModule || !('execute' in agentModule)) {
        res.status(404).json({ error: `Agent ${agent} not found` });
        return;
      }

      const result = await (agentModule as any).execute(command, params);
      res.json({ success: true, result });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });
}
