import type { Express } from 'express';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import type { InputLockManager } from '../../runtime/input-lock.js';
import type { Mailbox } from '../mailbox.js';

export interface RuntimeEventRouteDeps {
  eventBus: UnifiedEventBus;
  inputLockManager: InputLockManager;
  mailbox: Mailbox;
}

export function registerRuntimeEventRoutes(app: Express, deps: RuntimeEventRouteDeps): void {
  const { eventBus, inputLockManager, mailbox } = deps;

  app.get('/api/v1/events/types', (_req, res) => {
    res.json({
      success: true,
      types: eventBus.getSupportedTypes(),
    });
  });

  app.get('/api/v1/events/groups', (_req, res) => {
    res.json({
      success: true,
      groups: eventBus.getSupportedGroups(),
    });
  });

  app.get('/api/v1/events/history', (req, res) => {
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    const group = typeof req.query.group === 'string' ? req.query.group : undefined;
    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;

    if (type) {
      res.json({ success: true, events: eventBus.getHistoryByType(type, limit) });
      return;
    }

    if (group) {
      res.json({ success: true, events: eventBus.getHistoryByGroup(group as Parameters<typeof eventBus.getHistoryByGroup>[0], limit) });
      return;
    }

    res.json({ success: true, events: eventBus.getHistory(limit) });
  });

  app.get('/api/v1/input-lock/:sessionId', (req, res) => {
    const state = inputLockManager.getState(req.params.sessionId);
    res.json({ success: true, state });
  });

  app.get('/api/v1/input-lock', (_req, res) => {
    const locks = inputLockManager.getAllLocks();
    res.json({ success: true, locks });
  });

  app.get('/api/v1/mailbox', (req, res) => {
    const messages = mailbox.listMessages({
      target: req.query.target as string,
      status: req.query.status as any,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 10,
    });
    res.json({ messages });
  });

  app.get('/api/v1/mailbox/:id', (req, res) => {
    const msg = mailbox.getMessage(req.params.id);
    if (!msg) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    res.json(msg);
  });

  app.get('/api/v1/mailbox/callback/:callbackId', (req, res) => {
    const msg = mailbox.getMessageByCallbackId(req.params.callbackId);
    if (!msg) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    res.json(msg);
  });

  app.post('/api/v1/mailbox/clear', (_req, res) => {
    mailbox.cleanup();
    res.json({ success: true, message: 'Mailbox cleaned up' });
  });
}
