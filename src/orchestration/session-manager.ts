/**
 * Session Manager - 会话管理
 * 负责会话创建、恢复、隔离、上下文压缩
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Attachment } from '../runtime/events.js';

const FINGER_HOME = path.join(os.homedir(), '.finger');
const SESSIONS_DIR = path.join(FINGER_HOME, 'sessions');

export interface Session {
  id: string;
  name: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  messages: SessionMessage[];
  activeWorkflows: string[];
  context: Record<string, unknown>;
}

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'orchestrator';
  content: string;
  timestamp: string;
  workflowId?: string;
  taskId?: string;
  attachments?: Attachment[];
  type?: 'text' | 'command' | 'plan_update' | 'task_update';
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private sessionFilePaths: Map<string, string> = new Map();
  private currentSessionId: string | null = null;
  private readonly COMPRESS_THRESHOLD = 50;

  constructor() {
    this.ensureDirs();
    this.loadSessions();
  }

  private ensureDirs(): void {
    if (!fs.existsSync(FINGER_HOME)) {
      fs.mkdirSync(FINGER_HOME, { recursive: true });
    }
    if (!fs.existsSync(SESSIONS_DIR)) {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
  }

  private getProjectDirName(projectPath: string): string {
    const normalizedPath = path.resolve(projectPath).replace(/\\/g, '/');
    const encoded = normalizedPath.replace(/[/:]/g, '_');
    return encoded.length > 0 ? encoded : '_';
  }

  private getProjectSessionsDir(projectPath: string): string {
    return path.join(SESSIONS_DIR, this.getProjectDirName(projectPath));
  }

  private getSessionPath(session: Session): string {
    return path.join(this.getProjectSessionsDir(session.projectPath), `${session.id}.json`);
  }

  private loadSessionFile(filePath: string): void {
    const content = fs.readFileSync(filePath, 'utf-8');
    const session = JSON.parse(content) as Session;
    if (!session.id || !session.projectPath) {
      throw new Error('Invalid session content');
    }
    session.projectPath = path.resolve(session.projectPath);
    this.sessions.set(session.id, session);
    this.sessionFilePaths.set(session.id, filePath);
  }

  private loadSessionsFromDir(dirPath: string): void {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = path.join(dirPath, entry.name);
      try {
        this.loadSessionFile(filePath);
      } catch (err) {
        console.error(`[SessionManager] Failed to load session ${filePath}:`, err);
      }
    }
  }

  private loadSessions(): void {
    if (!fs.existsSync(SESSIONS_DIR)) return;

    const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        this.loadSessionsFromDir(path.join(SESSIONS_DIR, entry.name));
        continue;
      }
      // Backward compatibility: load legacy flat session files.
      if (entry.isFile() && entry.name.endsWith('.json')) {
        const legacyFilePath = path.join(SESSIONS_DIR, entry.name);
        try {
          this.loadSessionFile(legacyFilePath);
        } catch (err) {
          console.error(`[SessionManager] Failed to load legacy session ${legacyFilePath}:`, err);
        }
      }
    }

    // Auto-resume most recent session
    const sorted = this.listSessions().sort(
      (a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime()
    );
    if (sorted.length > 0) {
      this.currentSessionId = sorted[0].id;
      console.log(`[SessionManager] Auto-resumed session: ${sorted[0].name}`);
    }
  }

  private saveSession(session: Session): void {
    session.updatedAt = new Date().toISOString();
    const sessionDir = this.getProjectSessionsDir(session.projectPath);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const filePath = this.getSessionPath(session);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2));

    const previousPath = this.sessionFilePaths.get(session.id);
    if (previousPath && previousPath !== filePath && fs.existsSync(previousPath)) {
      fs.unlinkSync(previousPath);
    }
    this.sessionFilePaths.set(session.id, filePath);
  }

  createSession(projectPath: string, name?: string): Session {
    const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const normalizedPath = path.resolve(projectPath);
    
    const session: Session = {
      id,
      name: name || path.basename(normalizedPath),
      projectPath: normalizedPath,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      messages: [],
      activeWorkflows: [],
      context: {},
    };

    this.sessions.set(id, session);
    this.saveSession(session);
    this.currentSessionId = id;

    console.log(`[SessionManager] Created session: ${session.name} (${id})`);
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastAccessedAt = new Date().toISOString();
    }
    return session;
  }

  getCurrentSession(): Session | null {
    if (!this.currentSessionId) return null;
    return this.getSession(this.currentSessionId) || null;
  }

  setCurrentSession(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false;
    this.currentSessionId = sessionId;
    const session = this.sessions.get(sessionId)!;
    session.lastAccessedAt = new Date().toISOString();
    this.saveSession(session);
    return true;
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime()
    );
  }

  findSessionsByProjectPath(projectPath: string): Session[] {
    const normalized = path.resolve(projectPath);
    const prefix = normalized.endsWith(path.sep) ? normalized : `${normalized}${path.sep}`;
    return this.listSessions().filter(
      (session) => session.projectPath === normalized || session.projectPath.startsWith(prefix),
    );
  }

  addMessage(
    sessionId: string,
    role: SessionMessage['role'],
    content: string,
    metadata?: { workflowId?: string; taskId?: string; attachments?: Attachment[] }
  ): SessionMessage | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const message: SessionMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role,
      content,
      timestamp: new Date().toISOString(),
      ...metadata,
      attachments: metadata?.attachments,
    };

    session.messages.push(message);
    session.lastAccessedAt = new Date().toISOString();

    this.saveSession(session);
    return message;
  }

  getMessages(sessionId: string, limit = 50): SessionMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    if (!Number.isFinite(limit) || limit <= 0) {
      return [...session.messages];
    }
    return session.messages.slice(-limit);
  }

  updateMessage(sessionId: string, messageId: string, content: string): SessionMessage | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const normalized = content.trim();
    if (normalized.length === 0) {
      throw new Error('Message content cannot be empty');
    }

    const index = session.messages.findIndex((item) => item.id === messageId);
    if (index < 0) return null;

    const updated: SessionMessage = {
      ...session.messages[index],
      content: normalized,
      timestamp: new Date().toISOString(),
    };
    session.messages[index] = updated;
    session.lastAccessedAt = new Date().toISOString();
    this.saveSession(session);
    return updated;
  }

  deleteMessage(sessionId: string, messageId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const next = session.messages.filter((item) => item.id !== messageId);
    if (next.length === session.messages.length) {
      return false;
    }

    session.messages = next;
    session.lastAccessedAt = new Date().toISOString();
    this.saveSession(session);
    return true;
  }

  /**
   * 获取完整上下文 (包含压缩摘要)
   */
  getFullContext(sessionId: string): { messages: SessionMessage[]; compressedSummary?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return { messages: [] };

    const compressed = session.context.compressedHistory as { summary?: string } | undefined;
    return {
      messages: session.messages,
      compressedSummary: compressed?.summary,
    };
  }

  /**
   * 上下文压缩 (摘要式)
   */
  async compressContext(sessionId: string, summarizer?: (messages: SessionMessage[]) => Promise<string>): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    if (session.messages.length <= this.COMPRESS_THRESHOLD) {
      return 'No compression needed';
    }

    const earlyMessages = session.messages.slice(0, -this.COMPRESS_THRESHOLD);
    const recentMessages = session.messages.slice(-this.COMPRESS_THRESHOLD);

    let summary: string;
    if (summarizer) {
      summary = await summarizer(earlyMessages);
    } else {
      summary = this.defaultSummarize(earlyMessages);
    }

    session.context = {
      ...session.context,
      compressedHistory: {
        timestamp: new Date().toISOString(),
        originalCount: earlyMessages.length,
        summary,
      },
    };
    session.messages = recentMessages;

    this.saveSession(session);
    console.log(`[SessionManager] Compressed ${earlyMessages.length} messages for session ${sessionId}`);

    return summary;
  }

  private defaultSummarize(messages: SessionMessage[]): string {
    const userMessages = messages.filter(m => m.role === 'user');
    const assistantMessages = messages.filter(m => m.role === 'assistant' || m.role === 'orchestrator');

    const parts: string[] = [];
    if (userMessages.length > 0) {
      parts.push(`用户请求: ${userMessages.map(m => m.content.slice(0, 100)).join('; ')}`);
    }
    if (assistantMessages.length > 0) {
      parts.push(`助手响应: ${assistantMessages.length} 条`);
    }
    const taskIds = new Set(messages.map(m => m.taskId).filter(Boolean));
    if (taskIds.size > 0) {
      parts.push(`涉及任务: ${Array.from(taskIds).join(', ')}`);
    }

    return parts.join('\n');
  }

  getCompressionStatus(sessionId: string): { compressed: boolean; summary?: string; originalCount?: number } {
    const session = this.sessions.get(sessionId);
    if (!session) return { compressed: false };
    const compressed = session.context.compressedHistory as { summary?: string; originalCount?: number } | undefined;
    return { compressed: !!compressed, summary: compressed?.summary, originalCount: compressed?.originalCount };
  }

  pauseSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.context = { ...session.context, paused: true, pausedAt: new Date().toISOString() };
    this.saveSession(session);
    return true;
  }

  resumeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.context = { ...session.context, paused: false, resumedAt: new Date().toISOString() };
    this.saveSession(session);
    return true;
  }

  isPaused(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.context.paused === true;
  }

  updateContext(sessionId: string, context: Record<string, unknown>): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.context = { ...session.context, ...context };
    this.saveSession(session);
    return true;
  }

  addWorkflowToSession(sessionId: string, workflowId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (!session.activeWorkflows.includes(workflowId)) {
      session.activeWorkflows.push(workflowId);
      this.saveSession(session);
    }
    return true;
  }

  deleteSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const candidatePaths = new Set<string>();
    const trackedPath = this.sessionFilePaths.get(sessionId);
    if (trackedPath) candidatePaths.add(trackedPath);
    candidatePaths.add(this.getSessionPath(session));

    for (const filePath of candidatePaths) {
      if (!fs.existsSync(filePath)) continue;
      fs.unlinkSync(filePath);
      const parentDir = path.dirname(filePath);
      if (parentDir !== SESSIONS_DIR && fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
        fs.rmdirSync(parentDir);
      }
    }

    this.sessions.delete(sessionId);
    this.sessionFilePaths.delete(sessionId);
    if (this.currentSessionId === sessionId) {
      const remaining = this.listSessions();
      this.currentSessionId = remaining.length > 0 ? remaining[0].id : null;
    }
    return true;
  }

  renameSession(sessionId: string, nextName: string): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const normalized = nextName.trim();
    if (!normalized) {
      throw new Error('Session name cannot be empty');
    }
    session.name = normalized;
    session.lastAccessedAt = new Date().toISOString();
    this.saveSession(session);
    return session;
  }
}
