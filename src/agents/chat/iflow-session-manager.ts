/**
 * iFlow Session Manager - 基于 iFlow SDK 的会话管理
 */

import { IflowBaseAgent } from '../sdk/iflow-base.js';
import type { IflowAgentInfo } from '../sdk/iflow-base.js';
import {
  ISessionManager,
  Session,
  SessionMessage,
  SessionStatus,
  CreateSessionParams,
  UpdateSessionParams,
  SessionQuery,
  SessionStats,
} from './session-types.js';
import { logger } from '../../core/logger.js';

const log = logger.module('IflowSessionManager');

export class IflowSessionManager extends IflowBaseAgent implements ISessionManager {
  private sessions: Map<string, Session> = new Map();
  private currentSessionId: string | null = null;

  override async initialize(): Promise<IflowAgentInfo> {
    const info = await super.initialize(false);
    log.info('IflowSessionManager initialized', { sessionId: this.info.sessionId });
    return info;
  }

  async createSession(params: CreateSessionParams = {}): Promise<Session> {
    const now = new Date().toISOString();
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const session: Session = {
      id: sessionId,
      title: params.title || '新会话',
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      status: SessionStatus.ACTIVE,
      messages: params.initialMessages || [],
      metadata: params.metadata,
      messageCount: params.initialMessages?.length || 0,
    };

    this.sessions.set(sessionId, session);
    this.currentSessionId = sessionId;

    log.info('Created session', { sessionId });
    return session;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;
    return await this.restoreSession(sessionId);
  }

  async updateSession(sessionId: string, params: UpdateSessionParams): Promise<Session | null> {
    const session = await this.getSession(sessionId);
    if (!session) return null;

    if (params.title !== undefined) session.title = params.title;
    if (params.status !== undefined) session.status = params.status;
    if (params.metadata !== undefined) session.metadata = { ...session.metadata, ...params.metadata };

    session.updatedAt = new Date().toISOString();
    this.sessions.set(sessionId, session);

    return session;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    this.sessions.delete(sessionId);
    if (this.currentSessionId === sessionId) this.currentSessionId = null;

    log.info('Deleted session', { sessionId });
    return true;
  }

  async querySessions(query: SessionQuery = {}): Promise<Session[]> {
    let results = Array.from(this.sessions.values());
    if (query.status) results = results.filter(s => s.status === query.status);

    const sortBy = query.sortBy || 'lastActivityAt';
    const sortOrder = query.sortOrder || 'desc';
    results.sort((a, b) => {
      const aTime = new Date(a[sortBy] || a.createdAt).getTime();
      const bTime = new Date(b[sortBy] || b.createdAt).getTime();
      return sortOrder === 'desc' ? bTime - aTime : aTime - bTime;
    });

    const offset = query.offset || 0;
    const limit = query.limit || 100;
    return results.slice(offset, offset + limit);
  }

  async addMessage(sessionId: string, message: Omit<SessionMessage, 'id' | 'timestamp'>): Promise<SessionMessage> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const newMessage: SessionMessage = {
      ...message,
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
    };

    session.messages.push(newMessage);
    session.messageCount++;
    session.lastActivityAt = newMessage.timestamp;
    session.updatedAt = newMessage.timestamp;

    if (session.messages.length === 1 && message.role === 'user') {
      session.title = message.content.slice(0, 50) + (message.content.length > 50 ? '...' : '');
    }

    this.sessions.set(sessionId, session);

    return newMessage;
  }

  async getMessageHistory(sessionId: string, limit?: number): Promise<SessionMessage[]> {
    const session = await this.getSession(sessionId);
    if (!session) return [];
    const messages = [...session.messages];
    return limit ? messages.slice(-limit) : messages;
  }

  async deleteMessage(sessionId: string, messageId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) return false;

    const index = session.messages.findIndex(m => m.id === messageId);
    if (index === -1) return false;

    session.messages.splice(index, 1);
    session.messageCount--;
    session.updatedAt = new Date().toISOString();
    this.sessions.set(sessionId, session);

    return true;
  }

  async restoreSession(sessionId: string): Promise<Session | null> {
    const session = this.sessions.get(sessionId);
    if (session) return session;
    return null;
  }

  async restoreAllSessions(): Promise<number> {
    log.info('Restored all sessions', { count: this.sessions.size });
    return this.sessions.size;
  }

  async cleanupExpiredSessions(ttlDays = 30): Promise<number> {
    const now = Date.now();
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    let count = 0;

    for (const [sessionId, session] of this.sessions) {
      const lastActivity = new Date(session.lastActivityAt).getTime();
      if (now - lastActivity > ttlMs) {
        if (await this.deleteSession(sessionId)) count++;
      }
    }

    log.info('Cleaned up expired sessions', { count });
    return count;
  }

  async getStats(): Promise<SessionStats> {
    const sessions = Array.from(this.sessions.values());
    const totalMessages = sessions.reduce((sum, s) => sum + s.messageCount, 0);

    return {
      totalSessions: sessions.length,
      activeSessions: sessions.filter(s => s.status === SessionStatus.ACTIVE).length,
      totalMessages,
    };
  }

  async destroy(): Promise<void> {
    this.sessions.clear();
    this.currentSessionId = null;
    log.info('IflowSessionManager destroyed');
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  async setCurrentSession(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) return false;
    this.currentSessionId = sessionId;
    return true;
  }

  async getCurrentSession(): Promise<Session | null> {
    if (!this.currentSessionId) return null;
    return this.getSession(this.currentSessionId);
  }
}

export const iflowSessionManager = new IflowSessionManager();
export default IflowSessionManager;
