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

  private getSessionPath(sessionId: string): string {
    return path.join(SESSIONS_DIR, `${sessionId}.json`);
  }

  private loadSessions(): void {
    if (!fs.existsSync(SESSIONS_DIR)) return;

    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8');
        const session = JSON.parse(content) as Session;
        this.sessions.set(session.id, session);
      } catch (err) {
        console.error(`[SessionManager] Failed to load session ${file}:`, err);
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
    const filePath = this.getSessionPath(session.id);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
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
    
    // Keep only last 100 messages
    if (session.messages.length > 100) {
      session.messages = session.messages.slice(-100);
    }

    this.saveSession(session);
    return message;
  }

  getMessages(sessionId: string, limit = 50): SessionMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.messages.slice(-limit);
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
    if (!this.sessions.has(sessionId)) return false;
    
    const filePath = this.getSessionPath(sessionId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    this.sessions.delete(sessionId);
    if (this.currentSessionId === sessionId) {
      const remaining = this.listSessions();
      this.currentSessionId = remaining.length > 0 ? remaining[0].id : null;
    }
    return true;
  }
}
