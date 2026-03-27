import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import type { SessionManager } from '../../orchestration/session-manager.js';
import { isObjectRecord } from '../common/object.js';
import { asString } from '../common/strings.js';

export interface SessionLog {
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

export async function loadSessionLog(sessionId: string, logsDir: string): Promise<SessionLog | null> {
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

export async function loadAllSessionLogs(logsDir: string): Promise<SessionLog[]> {
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

export function summarizePreviewContent(content: string, maxChars = 80): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

export function formatSessionPreview(
  sessionManager: SessionManager,
  session: ReturnType<SessionManager['listSessions']>[number],
): {
  previewSummary: string;
  previewMessages: Array<{ role: string; timestamp: string; summary: string }>;
  lastMessageAt?: string;
} {
  const snapshot = sessionManager.getSessionMessageSnapshot(session.id, 3);
  const previewMessages = snapshot.previewMessages.map((item) => ({
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
    ...(snapshot.lastMessageAt ? { lastMessageAt: snapshot.lastMessageAt } : {}),
  };
}

export function toSessionResponse(
  sessionManager: SessionManager,
  session: ReturnType<SessionManager['listSessions']>[number],
): Record<string, unknown> {
  const context = isObjectRecord(session.context) ? session.context : {};
  const sessionTier = asString(context.sessionTier);
  const ownerAgentId = asString(context.ownerAgentId);
  const rootSessionId = asString(context.rootSessionId);
  const parentSessionId = asString(context.parentSessionId);
  const sessionWorkspaceRoot = asString(context.sessionWorkspaceRoot);
  const snapshot = sessionManager.getSessionMessageSnapshot(session.id, 3);
  return {
    id: session.id,
    name: session.name,
    projectPath: session.projectPath,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastAccessedAt: session.lastAccessedAt,
    messageCount: snapshot.messageCount,
    activeWorkflows: session.activeWorkflows,
    ...(sessionTier ? { sessionTier } : {}),
    ...(ownerAgentId ? { ownerAgentId } : {}),
    ...(rootSessionId ? { rootSessionId } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(sessionWorkspaceRoot ? { sessionWorkspaceRoot } : {}),
    ...formatSessionPreview(sessionManager, session),
  };
}

export function hasActiveWorkflowEntry(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.some((item) => typeof item === 'string' && item.trim().length > 0);
}
