import { logger } from '../../core/logger.js';
import type { Express } from 'express';
import { existsSync, readFileSync } from 'fs';
import type { SessionManager } from '../../orchestration/session-manager.js';
import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import type { Attachment } from '../../runtime/events.js';
import { SYSTEM_PROJECT_PATH } from '../../agents/finger-system-agent/index.js';
import { buildContext } from '../../runtime/context-builder.js';
import { listLedgerSessionsSnapshot } from './ledger-routes-storage.js';
import {
  hasActiveWorkflowEntry,
  loadAllSessionLogs,
  loadSessionLog,
  toSessionResponse,
} from './session-helpers.js';

export interface SessionRouteDeps {
  sessionManager: SessionManager;
  runtime: RuntimeFacade;
  eventBus: UnifiedEventBus;
  logsDir: string;
  resolveSessionLoopLogPath: (sessionId: string) => string;
  interruptSession?: (sessionId: string) => Promise<unknown>;
}

export function registerSessionRoutes(app: Express, deps: SessionRouteDeps): void {
  const { sessionManager, runtime, eventBus, logsDir, resolveSessionLoopLogPath } = deps;

  // System session alias: resolve 'system-default-session' to actual system session
  const resolveSystemSessionId = (sessionId: string): string => {
    if (sessionId === 'system-default-session' || sessionId === 'system-1') {
      const systemSession = sessionManager.getOrCreateSystemSession();
      return systemSession.id;
    }
    if (sessionId.startsWith('system-')) {
      const existing = sessionManager.getSession(sessionId);
      if (!existing) {
        return sessionManager.getOrCreateSystemSession().id;
      }
    }
    return sessionId;
  };

  app.get('/api/v1/sessions/:sessionId/execution', async (req, res) => {
    const sessionId = resolveSystemSessionId(req.params.sessionId);
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const logs = await loadAllSessionLogs(logsDir);
      const relatedLogs = logs.filter((l) => l.sessionId?.includes(sessionId) || sessionId.includes(l.sessionId));
      res.json({
        success: true,
        session: {
          id: session.id,
          name: session.name,
          projectPath: session.projectPath,
          messages: sessionManager.getMessages(session.id, 0),
          activeWorkflows: session.activeWorkflows,
        },
        executionLogs: relatedLogs,
      });
    } catch (e) {
      res.status(404).json({ error: 'Session not found', details: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/api/v1/sessions/match', (req, res) => {
    const projectPath = req.query.projectPath;
    if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
      res.status(400).json({ error: 'Missing projectPath' });
      return;
    }
    const matched = sessionManager.findSessionsByProjectPath(projectPath);
    res.json(matched.map((session) => ({
      id: session.id,
      name: session.name,
      projectPath: session.projectPath,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastAccessedAt: session.lastAccessedAt,
      messageCount: sessionManager.getSessionMessageSnapshot(session.id, 0).messageCount,
      activeWorkflows: session.activeWorkflows,
    })));
  });

  app.get('/api/v1/execution-logs', async (_req, res) => {
    const logs = await loadAllSessionLogs(logsDir);
    res.json({ success: true, logs });
  });

  app.get('/api/v1/execution-logs/:sessionId', async (req, res) => {
    const log = await loadSessionLog(resolveSystemSessionId(req.params.sessionId), logsDir);
    if (!log) {
      res.status(404).json({ error: 'Log not found' });
      return;
    }
    res.json({ success: true, log });
  });

  app.get('/api/v1/sessions', (_req, res) => {
    // Legacy endpoint now proxies ledger SSOT to avoid old session-file drift.
    const includeSystem = _req.query.includeSystem === '1';
    const sessions = listLedgerSessionsSnapshot();
    const filtered = includeSystem
      ? sessions
      : sessions.filter((s: Record<string, unknown>) => {
          const projectPath = String(s.projectPath || '');
          const sessionTier = String(s.sessionTier || '');
          const ownerAgentId = String(s.ownerAgentId || '');
          const id = String(s.id || '');
          return projectPath !== SYSTEM_PROJECT_PATH
            && sessionTier !== 'system'
            && !id.startsWith('system-')
            && ownerAgentId !== 'finger-system-agent';
        });
    res.json(filtered);
  });

  app.get('/api/v1/sessions/current', (_req, res) => {
    sessionManager.refreshSessionsFromDisk();
    const session = sessionManager.getCurrentSession();
    if (!session) {
      res.status(404).json({ error: 'No current session' });
      return;
    }
    res.json(toSessionResponse(sessionManager, session));
  });

  app.post('/api/v1/sessions/current', (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
      res.status(400).json({ error: 'Missing sessionId' });
      return;
    }
    const success = sessionManager.setCurrentSession(sessionId);
    if (!success) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({ success: true });
  });

  app.post('/api/v1/sessions', (req, res) => {
    const { projectPath, name } = req.body;
    const session = sessionManager.createSession(projectPath || process.cwd(), name);
    res.json(toSessionResponse(sessionManager, session));
  });

  app.post('/api/v1/sessions/project/delete', (req, res) => {
    const { projectPath, allowActive } = req.body as { projectPath?: string; allowActive?: boolean };
    if (!projectPath || typeof projectPath !== 'string' || projectPath.trim().length === 0) {
      res.status(400).json({ error: 'Missing projectPath' });
      return;
    }
    sessionManager.refreshSessionsFromDisk();
    const result = sessionManager.deleteProjectSessions(projectPath, { allowActive: allowActive === true });
    if (result.hadActive) {
      res.status(409).json({ error: 'Project has active workflows' });
      return;
    }
    res.json({ success: true, removed: result.removed, projectDir: result.projectDir });
  });

  app.get('/api/v1/sessions/:id', (req, res) => {
    sessionManager.refreshSessionsFromDisk();
    const session = sessionManager.getSession(resolveSystemSessionId(req.params.id));
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(toSessionResponse(sessionManager, session));
  });

  app.patch('/api/v1/sessions/:id', (req, res) => {
    const { name } = req.body as { name?: string };
    if (typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'Missing name' });
      return;
    }
    try {
      const session = sessionManager.renameSession(resolveSystemSessionId(req.params.id), name);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      res.json(toSessionResponse(sessionManager, session));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to rename session' });
    }
  });

  app.delete('/api/v1/sessions/:id', async (req, res) => {
    const sessionId = resolveSystemSessionId(req.params.id);

    // Interrupt running agent before deleting session
    let interrupted = false;
    if (deps.interruptSession) {
      try {
        await deps.interruptSession(sessionId);
        interrupted = true;
      } catch {
        // Session may not be running, continue with delete
      }
    }

    // Delete persisted session + ledger data
    const success = sessionManager.deleteSession(sessionId);
    if (!success) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({ success: true, interrupted });
  });

  app.get('/api/v1/sessions/:sessionId/messages', (req, res) => {
    sessionManager.refreshSessionsFromDisk();
    const parsedLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;
    void sessionManager
      .getMessagesAsync(resolveSystemSessionId(req.params.sessionId), limit)
      .then((messages) => {
        res.json({ success: true, messages });
      })
      .catch((err) => {
        const sessionLog = logger.module('SessionRoute');
        sessionLog.error('getMessagesAsync failed', err instanceof Error ? err : undefined, { sessionId: req.params.sessionId });
        // Fallback to sync getMessages if ledger read fails
        const fallback = sessionManager.getMessages(resolveSystemSessionId(req.params.sessionId), limit);
        res.json({ success: true, messages: fallback });
      });
  });

  app.get('/api/v1/sessions/:sessionId/loop-logs', (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 200;
    const logPath = resolveSessionLoopLogPath(resolveSystemSessionId(req.params.sessionId));
    if (!existsSync(logPath)) {
      res.json({ success: true, logs: [] });
      return;
    }
    try {
      const lines = readFileSync(logPath, 'utf-8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const parsed = lines
        .slice(-Math.max(1, limit))
        .map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return { timestamp: new Date().toISOString(), phase: 'parse_error', raw: line };
          }
        });
      res.json({ success: true, logs: parsed });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to read loop logs' });
    }
  });

  app.post('/api/v1/sessions/:sessionId/messages', async (req, res) => {
    const { content, attachments } = req.body;
    if (!content) {
      res.status(400).json({ error: 'Missing content' });
      return;
    }
    try {
      const result = await runtime.sendMessage(resolveSystemSessionId(req.params.sessionId), content, attachments);
      res.json({ success: true, messageId: result.messageId });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/api/v1/sessions/:sessionId/messages/append', async (req, res) => {
    const { role, content, attachments, metadata } = req.body as {
      role?: 'user' | 'assistant' | 'system';
      content?: string;
      attachments?: unknown;
      metadata?: Record<string, unknown>;
    };
    if (!role || (role !== 'user' && role !== 'assistant' && role !== 'system')) {
      res.status(400).json({ error: 'Invalid role' });
      return;
    }
    if (typeof content !== 'string' || content.length === 0) {
      res.status(400).json({ error: 'Missing content' });
      return;
    }
    const message = await sessionManager.addMessage(
      resolveSystemSessionId(req.params.sessionId),
      role,
      content,
      {
        ...(Array.isArray(attachments) ? { attachments: attachments as Attachment[] } : {}),
        ...(metadata ? { metadata } : {}),
      },
    );
    if (!message) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({ success: true, message });
  });

  app.patch('/api/v1/sessions/:sessionId/messages/:messageId', (req, res) => {
    const { content } = req.body as { content?: string };
    if (typeof content !== 'string' || content.trim().length === 0) {
      res.status(400).json({ error: 'Missing content' });
      return;
    }
    try {
      const updated = sessionManager.updateMessage(resolveSystemSessionId(req.params.sessionId), req.params.messageId, content);
      if (!updated) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }
      res.json({ success: true, message: updated });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to update message' });
    }
  });

  app.delete('/api/v1/sessions/:sessionId/messages/:messageId', (req, res) => {
    const deleted = sessionManager.deleteMessage(resolveSystemSessionId(req.params.sessionId), req.params.messageId);
    if (!deleted) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    res.json({ success: true });
  });

  app.post('/api/v1/sessions/:sessionId/pause', (req, res) => {
    const success = sessionManager.pauseSession(resolveSystemSessionId(req.params.sessionId));
    if (!success) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    void eventBus.emit({
      type: 'session_paused',
      sessionId: resolveSystemSessionId(req.params.sessionId),
      timestamp: new Date().toISOString(),
      payload: {},
    });
    res.json({ success: true });
  });

  app.post('/api/v1/sessions/:sessionId/resume', (req, res) => {
    const success = sessionManager.resumeSession(resolveSystemSessionId(req.params.sessionId));
    if (!success) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    void eventBus.emit({
      type: 'session_resumed',
      sessionId: resolveSystemSessionId(req.params.sessionId),
      timestamp: new Date().toISOString(),
      payload: { messageCount: sessionManager.getMessages(resolveSystemSessionId(req.params.sessionId)).length },
    });
    res.json({ success: true });
  });

  app.post('/api/v1/sessions/:sessionId/compress', async (req, res) => {
    try {
      const trigger = req.body?.trigger === 'auto' ? 'auto' : 'manual';
      const contextUsagePercent = typeof req.body?.contextUsagePercent === 'number' ? req.body.contextUsagePercent : undefined;
      const summary = await runtime.compressContext(resolveSystemSessionId(req.params.sessionId), { trigger, contextUsagePercent });
      const status = sessionManager.getCompressionStatus(resolveSystemSessionId(req.params.sessionId));
      res.json({ success: true, summary, originalCount: status.originalCount });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/api/v1/sessions/:sessionId/context', (req, res) => {
    const context = sessionManager.getFullContext(resolveSystemSessionId(req.params.sessionId));
    const status = sessionManager.getCompressionStatus(resolveSystemSessionId(req.params.sessionId));
    res.json({
      success: true,
      messages: context.messages,
      compressedSummary: context.compressedSummary,
      compressed: status.compressed,
      originalCount: status.originalCount,
    });
  });
}
