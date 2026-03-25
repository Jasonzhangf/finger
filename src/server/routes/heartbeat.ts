/**
 * Heartbeat Routes - 心跳配置与任务管理 API
 */

import type { Express } from 'express';
import {
  heartbeatEnableTool,
  heartbeatDisableTool,
  heartbeatStatusTool,
  heartbeatAddTaskTool,
  heartbeatCompleteTaskTool,
  heartbeatRemoveTaskTool,
  heartbeatListTasksTool,
  heartbeatBatchAddTool,
  heartbeatBatchCompleteTool,
  heartbeatBatchRemoveTool,
} from '../../tools/internal/heartbeat-control-tool.js';
import { createToolExecutionContext } from '../../tools/internal/types.js';

export function registerHeartbeatRoutes(app: Express): void {
  app.get('/api/v1/heartbeat/status', async (_req, res) => {
    try {
      const result = await heartbeatStatusTool.execute({}, createToolExecutionContext());
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  app.post('/api/v1/heartbeat/enable', async (req, res) => {
    try {
      const result = await heartbeatEnableTool.execute(req.body ?? {}, createToolExecutionContext());
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  app.post('/api/v1/heartbeat/disable', async (req, res) => {
    try {
      const result = await heartbeatDisableTool.execute(req.body ?? {}, createToolExecutionContext());
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  app.get('/api/v1/heartbeat/tasks', async (req, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : 'all';
      const result = await heartbeatListTasksTool.execute({ status }, createToolExecutionContext());
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  app.post('/api/v1/heartbeat/tasks/add', async (req, res) => {
    try {
      const result = await heartbeatAddTaskTool.execute(req.body ?? {}, createToolExecutionContext());
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  app.post('/api/v1/heartbeat/tasks/complete', async (req, res) => {
    try {
      const result = await heartbeatCompleteTaskTool.execute(req.body ?? {}, createToolExecutionContext());
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  app.post('/api/v1/heartbeat/tasks/remove', async (req, res) => {
    try {
      const result = await heartbeatRemoveTaskTool.execute(req.body ?? {}, createToolExecutionContext());
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  // Batch operations
  app.post('/api/v1/heartbeat/tasks/batch-add', async (req, res) => {
    try {
      const result = await heartbeatBatchAddTool.execute(req.body ?? {}, createToolExecutionContext());
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  app.post('/api/v1/heartbeat/tasks/batch-complete', async (req, res) => {
    try {
      const result = await heartbeatBatchCompleteTool.execute(req.body ?? {}, createToolExecutionContext());
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  app.post('/api/v1/heartbeat/tasks/batch-remove', async (req, res) => {
    try {
      const result = await heartbeatBatchRemoveTool.execute(req.body ?? {}, createToolExecutionContext());
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });
}
