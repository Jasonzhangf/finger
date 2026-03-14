/**
 * Clock Routes - 定时任务管理 API
 */

import type { Express } from 'express';
import { clockTool } from '../../tools/internal/codex-clock-tool.js';
import { createToolExecutionContext } from '../../tools/internal/types.js';

export interface ClockRouteDeps {
  // 预留扩展依赖
}

export function registerClockRoutes(app: Express, _deps: ClockRouteDeps): void {
  // GET /api/v1/clock/list - 列出所有定时任务
  app.get('/api/v1/clock/list', async (_req, res) => {
    try {
      const result = await clockTool.execute(
        { action: 'list', payload: {} },
        createToolExecutionContext()
      );
      res.json({ success: result.ok, timers: result.data.timers });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  // POST /api/v1/clock/create - 创建定时任务
  app.post('/api/v1/clock/create', async (req, res) => {
    const { message, schedule_type, delay_seconds, at, cron, timezone, repeat, max_runs, inject } = req.body;

    if (typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({ success: false, error: 'message is required' });
      return;
    }
    if (typeof schedule_type !== 'string') {
      res.status(400).json({ success: false, error: 'schedule_type is required' });
      return;
    }

    try {
      const result = await clockTool.execute(
        {
          action: 'create',
          payload: {
            message: message.trim(),
            schedule_type,
            delay_seconds,
            at,
            cron,
            timezone,
            repeat,
            max_runs,
            inject,
          },
        },
        createToolExecutionContext()
      );
      res.json({ success: result.ok, timer_id: result.timer_id, data: result.data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  // POST /api/v1/clock/cancel - 取消定时任务
  app.post('/api/v1/clock/cancel', async (req, res) => {
    const { timer_id } = req.body;

    if (typeof timer_id !== 'string' || timer_id.trim().length === 0) {
      res.status(400).json({ success: false, error: 'timer_id is required' });
      return;
    }

    try {
      const result = await clockTool.execute(
        { action: 'cancel', payload: { timer_id } },
        createToolExecutionContext()
      );
      res.json({ success: result.ok, data: result.data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  // POST /api/v1/clock/update - 更新定时任务
  app.post('/api/v1/clock/update', async (req, res) => {
    const { timer_id, message, schedule_type, delay_seconds, at, cron, timezone, repeat, max_runs, inject } = req.body;

    if (typeof timer_id !== 'string' || timer_id.trim().length === 0) {
      res.status(400).json({ success: false, error: 'timer_id is required' });
      return;
    }

    try {
      const result = await clockTool.execute(
        {
          action: 'update',
          payload: {
            timer_id,
            message,
            schedule_type,
            delay_seconds,
            at,
            cron,
            timezone,
            repeat,
            max_runs,
            inject,
          },
        },
        createToolExecutionContext()
      );
      res.json({ success: result.ok, timer_id: result.timer_id, data: result.data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });
}
