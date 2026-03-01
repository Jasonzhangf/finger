import type { Express } from 'express';
import { readdir, readFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { SessionManager } from '../../orchestration/session-manager.js';
import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import type { Attachment } from '../../runtime/events.js';
import { isObjectRecord } from '../common/object.js';
import { asString } from '../common/strings.js';

export interface SessionRouteDeps {
  sessionManager: SessionManager;
  runtime: RuntimeFacade;
  eventBus: UnifiedEventBus;
  logsDir: string;
  resolveSessionLoopLogPath: (sessionId: string) => string;
}

interface SessionLog {
  sessionId: string;
  agentId: string;
  agentRole: string;
  userTask: string;
  startTime: string;
  endTime?: string;
  success: boolean;
  iterations: Array<{
    round: number;
    action: string;
    thought?: string;
    params?: Record<string, unknown>;
    observation?: string;
    success: boolean;
    timestamp: string;
  }>;
  totalRounds: number;
  finalOutput?: string;
  finalError?: string;
}

async function loadSessionLog(sessionId: string, logsDir: string): Promise<SessionLog | null> {
  try {
    const files = await readdir(logsDir);
    const sessionFile = files.find((f) => f.startsWith(sessionId) || f.includes(sessionId));
    if (!sessionFile) return null;
    const content = await readFile(join(logsDir, sessionFile), 'utf-8');
    return JSON.parse(content) as SessionLog;
  } catch {
    return null;
  }
}

async function loadAllSessionLogs(logsDir: string): Promise<SessionLog[]> {
  try {
    const files = await readdir(logsDir);
    const logs: SessionLog[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await readFile(join(logsDir, file), 'utf-8');
        logs.push(JSON.parse(content) as SessionLog);
      } catch {
        // skip invalid files
      }
    }
    return logs.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  } catch {
    return [];
  }
}

function summarizePreviewContent(content: string, maxChars = 80): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function formatSessionPreview(session: ReturnType<SessionManager['listSessions']>[number]): {
  previewSummary: string;
  previewMessages: Array<{ role: string; timestamp: string; summary: string }>;
  lastMessageAt?: string;
} {
  const previewMessages = session.messages.slice(-3).map((item) => ({
    role: item.role,
    timestamp: item.timestamp,
    summary: summarizePreviewContent(item.content),
  }));
  const previewSummary = previewMessages
    .map((item) => `[${new Date(item.timestamp).toLocaleTimeString()}] ${item.role}: ${item.summary}`)
    .join('\n');
  return {
    previewSummary,
    previewMessages,
    ...(previewMessages.length > 0 ? { lastMessageAt: previewMessages[previewMessages.length - 1].timestamp } : {}),
  };
}

function toSessionResponse(session: ReturnType<SessionManager['listSessions']>[number]): Record<string, unknown> {
  const context = isObjectRecord(session.context) ? session.context : {};
  const sessionTier = asString(context.sessionTier);
  const ownerAgentId = asString(context.ownerAgentId);
  const rootSessionId = asString(context.rootSessionId);
  const parentSessionId = asString(context.parentSessionId);
  const sessionWorkspaceRoot = asString(context.sessionWorkspaceRoot);
  return {
    id: session.id,
    name: session.name,
    projectPath: session.projectPath,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastAccessedAt: session.lastAccessedAt,
    messageCount: session.messages.length,
    activeWorkflows: session.activeWorkflows,
    ...(sessionTier ? { sessionTier } : {}),
    ...(ownerAgentId ? { ownerAgentId } : {}),
    ...(rootSessionId ? { rootSessionId } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(sessionWorkspaceRoot ? { sessionWorkspaceRoot } : {}),
    ...formatSessionPreview(session),
  };
}

export function registerSessionRoutes(app: Express, deps: SessionRouteDeps): void {
  const { sessionManager, runtime, eventBus, logsDir, resolveSessionLoopLogPath } = deps;

  app.get('/api/v1/sessions/:sessionId/execution', async (req, res) => {
    const sessionId = req.params.sessionId;
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
          messages: session.messages,
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
      messageCount: session.messages.length,
      activeWorkflows: session.activeWorkflows,
    })));
  });

  app.get('/api/v1/execution-logs', async (_req, res) => {
    const logs = await loadAllSessionLogs(logsDir);
    res.json({ success: true, logs });
  });

  app.get('/api/v1/execution-logs/:sessionId', async (req, res) => {
    const log = await loadSessionLog(req.params.sessionId, logsDir);
    if (!log) {
      res.status(404).json({ error: 'Log not found' });
      return;
    }
    res.json({ success: true, log });
  });

  app.get('/api/v1/sessions', (_req, res) => {
    sessionManager.refreshSessionsFromDisk();
    const sessions = sessionManager.listRootSessions();
    res.json(sessions.map((session) => toSessionResponse(session)));
  });

  app.get('/api/v1/sessions/current', (_req, res) => {
    sessionManager.refreshSessionsFromDisk();
    const session = sessionManager.getCurrentSession();
    if (!session) {
      res.status(404).json({ error: 'No current session' });
      return;
    }
    res.json(toSessionResponse(session));
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
    res.json(toSessionResponse(session));
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
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(toSessionResponse(session));
  });

  app.patch('/api/v1/sessions/:id', (req, res) => {
    const { name } = req.body as { name?: string };
    if (typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'Missing name' });
      return;
    }
    try {
      const session = sessionManager.renameSession(req.params.id, name);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      res.json(toSessionResponse(session));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to rename session' });
    }
  });

  app.delete('/api/v1/sessions/:id', (req, res) => {
    const success = sessionManager.deleteSession(req.params.id);
    if (!success) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({ success: true });
  });

  app.get('/api/v1/sessions/:sessionId/messages', (req, res) => {
    sessionManager.refreshSessionsFromDisk();
    const parsedLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;
    const messages = sessionManager.getMessages(req.params.sessionId, limit);
    res.json({ success: true, messages });
  });

  app.get('/api/v1/sessions/:sessionId/loop-logs', (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 200;
    const logPath = resolveSessionLoopLogPath(req.params.sessionId);
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
      const result = await runtime.sendMessage(req.params.sessionId, content, attachments);
      res.json({ success: true, messageId: result.messageId });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/api/v1/sessions/:sessionId/messages/append', (req, res) => {
    const { role, content, attachments } = req.body as {
      role?: 'user' | 'assistant' | 'system' | 'orchestrator';
      content?: string;
      attachments?: unknown;
    };
    if (!role || (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'orchestrator')) {
      res.status(400).json({ error: 'Invalid role' });
      return;
    }
    if (typeof content !== 'string' || content.length === 0) {
      res.status(400).json({ error: 'Missing content' });
      return;
    }
    const message = sessionManager.addMessage(
      req.params.sessionId,
      role,
      content,
      Array.isArray(attachments) ? { attachments: attachments as Attachment[] } : undefined,
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
      const updated = sessionManager.updateMessage(req.params.sessionId, req.params.messageId, content);
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
    const deleted = sessionManager.deleteMessage(req.params.sessionId, req.params.messageId);
    if (!deleted) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    res.json({ success: true });
  });

  app.post('/api/v1/sessions/:sessionId/pause', (req, res) => {
    const success = sessionManager.pauseSession(req.params.sessionId);
    if (!success) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    void eventBus.emit({
      type: 'session_paused',
      sessionId: req.params.sessionId,
      timestamp: new Date().toISOString(),
      payload: {},
    });
    res.json({ success: true });
  });

  app.post('/api/v1/sessions/:sessionId/resume', (req, res) => {
    const success = sessionManager.resumeSession(req.params.sessionId);
    if (!success) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    void eventBus.emit({
      type: 'session_resumed',
      sessionId: req.params.sessionId,
      timestamp: new Date().toISOString(),
      payload: { messageCount: sessionManager.getMessages(req.params.sessionId).length },
    });
    res.json({ success: true });
  });

  app.post('/api/v1/sessions/:sessionId/compress', async (req, res) => {
    try {
      const summary = await sessionManager.compressContext(req.params.sessionId);
      const status = sessionManager.getCompressionStatus(req.params.sessionId);
      res.json({ success: true, summary, originalCount: status.originalCount });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/api/v1/sessions/:sessionId/context', (req, res) => {
    const context = sessionManager.getFullContext(req.params.sessionId);
    const status = sessionManager.getCompressionStatus(req.params.sessionId);
    res.json({
      success: true,
      messages: context.messages,
      compressedSummary: context.compressedSummary,
      compressed: status.compressed,
      originalCount: status.originalCount,
    });
  });
}
