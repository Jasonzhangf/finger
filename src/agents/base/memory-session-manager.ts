import {
  type CreateSessionParams,
  type ISessionManager,
  type Session,
  type SessionMessage,
  SessionStatus,
  type SessionQuery,
  type SessionStats,
  type UpdateSessionParams,
} from '../chat/session-types.js';

export class MemorySessionManager implements ISessionManager {
  private readonly sessions = new Map<string, Session>();

  async initialize(): Promise<void> {
    return;
  }

  async createSession(params: CreateSessionParams = {}): Promise<Session> {
    const now = new Date().toISOString();
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const initialMessages = params.initialMessages ? [...params.initialMessages] : [];

    const session: Session = {
      id: sessionId,
      title: params.title || '新会话',
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      status: SessionStatus.ACTIVE,
      messages: initialMessages,
      metadata: params.metadata,
      messageCount: initialMessages.length,
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async updateSession(sessionId: string, params: UpdateSessionParams): Promise<Session | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    if (params.title !== undefined) session.title = params.title;
    if (params.status !== undefined) session.status = params.status;
    if (params.metadata !== undefined) {
      session.metadata = {
        ...(session.metadata ?? {}),
        ...params.metadata,
      };
    }
    session.updatedAt = new Date().toISOString();
    this.sessions.set(sessionId, session);
    return session;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.sessions.delete(sessionId);
  }

  async querySessions(query: SessionQuery = {}): Promise<Session[]> {
    let list = Array.from(this.sessions.values());

    if (query.status) {
      list = list.filter((item) => item.status === query.status);
    }

    const sortBy = query.sortBy ?? 'lastActivityAt';
    const sortOrder = query.sortOrder ?? 'desc';
    list.sort((a, b) => {
      const at = new Date(a[sortBy]).getTime();
      const bt = new Date(b[sortBy]).getTime();
      return sortOrder === 'asc' ? at - bt : bt - at;
    });

    const offset = query.offset ?? 0;
    const limit = query.limit ?? list.length;
    return list.slice(offset, offset + limit);
  }

  async addMessage(
    sessionId: string,
    message: Omit<SessionMessage, 'id' | 'timestamp'>,
  ): Promise<SessionMessage> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const now = new Date().toISOString();
    const saved: SessionMessage = {
      ...message,
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: now,
    };

    session.messages.push(saved);
    session.messageCount += 1;
    session.lastActivityAt = now;
    session.updatedAt = now;
    this.sessions.set(sessionId, session);
    return saved;
  }

  async getMessageHistory(sessionId: string, limit?: number): Promise<SessionMessage[]> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    if (!limit || limit <= 0) return [...session.messages];
    return session.messages.slice(-limit);
  }

  async deleteMessage(sessionId: string, messageId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const index = session.messages.findIndex((item) => item.id === messageId);
    if (index < 0) return false;

    session.messages.splice(index, 1);
    session.messageCount = Math.max(0, session.messageCount - 1);
    session.updatedAt = new Date().toISOString();
    this.sessions.set(sessionId, session);
    return true;
  }

  async restoreSession(sessionId: string): Promise<Session | null> {
    return this.getSession(sessionId);
  }

  async restoreAllSessions(): Promise<number> {
    return this.sessions.size;
  }

  async cleanupExpiredSessions(ttlDays = 30): Promise<number> {
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let removed = 0;

    for (const [id, session] of this.sessions.entries()) {
      const lastActivity = new Date(session.lastActivityAt).getTime();
      if (now - lastActivity > ttlMs) {
        this.sessions.delete(id);
        removed += 1;
      }
    }

    return removed;
  }

  async getStats(): Promise<SessionStats> {
    const sessions = Array.from(this.sessions.values());
    return {
      totalSessions: sessions.length,
      activeSessions: sessions.filter((item) => item.status === SessionStatus.ACTIVE).length,
      totalMessages: sessions.reduce((sum, item) => sum + item.messageCount, 0),
    };
  }

  async destroy(): Promise<void> {
    this.sessions.clear();
  }
}

export default MemorySessionManager;
