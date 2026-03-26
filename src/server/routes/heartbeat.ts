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
import { heartbeatMailbox } from '../modules/heartbeat-mailbox.js';
import { buildUserNotificationEnvelope } from '../modules/mailbox-envelope.js';

type MailboxNotifyPriority = 'high' | 'medium' | 'low';

function resolveMailboxNotifyPriority(raw: unknown): MailboxNotifyPriority {
  if (typeof raw !== 'string') return 'medium';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') return normalized;
  return 'medium';
}

function mapPriorityToMailboxLevel(priority: MailboxNotifyPriority): 0 | 1 | 2 | 3 {
  if (priority === 'high') return 0;
  if (priority === 'medium') return 1;
  return 2;
}

function pickNonEmptyString(raw: unknown, fallback?: string): string | undefined {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

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

  app.post('/api/v1/heartbeat/mailbox/notify', (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const targetAgentId = pickNonEmptyString(body.targetAgentId);
      const message = pickNonEmptyString(body.message) ?? pickNonEmptyString(body.description);
      if (!targetAgentId) {
        res.status(400).json({ success: false, error: 'targetAgentId is required' });
        return;
      }
      if (!message) {
        res.status(400).json({ success: false, error: 'message is required' });
        return;
      }

      const priority = resolveMailboxNotifyPriority(body.priority);
      const title = pickNonEmptyString(body.title, 'Scheduled Mailbox Notification')!;
      const sender = pickNonEmptyString(body.sender, 'mailbox-cli');
      const source = pickNonEmptyString(body.source, 'mailbox-cli')!;
      const sessionId = pickNonEmptyString(body.sessionId);
      const channel = pickNonEmptyString(body.channel);

      const envelope = buildUserNotificationEnvelope(title, message, priority);
      const appended = heartbeatMailbox.append(targetAgentId, {
        type: 'external-notification',
        source,
        title,
        message,
        envelopeId: envelope.id,
        envelope,
      }, {
        ...(sender ? { sender } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(channel ? { channel } : {}),
        sourceType: 'observe',
        category: 'notification',
        priority: mapPriorityToMailboxLevel(priority),
        deliveryPolicy: 'realtime',
      });

      res.json({
        success: true,
        targetAgentId,
        messageId: appended.id,
        seq: appended.seq,
        summary: `${title} -> ${targetAgentId}`,
        nextAction: 'Use normal queue/injection path to wake the agent if immediate handling is required.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });
}
