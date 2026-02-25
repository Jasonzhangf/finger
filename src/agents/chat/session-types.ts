/**
 * Session Types - 会话管理抽象接口
 */

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export enum SessionStatus {
  ACTIVE = 'active',
  PAUSED = 'paused',
  ARCHIVED = 'archived',
  CLOSED = 'closed',
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  status: SessionStatus;
  messages: SessionMessage[];
  metadata?: Record<string, unknown>;
  messageCount: number;
}

export interface CreateSessionParams {
  title?: string;
  metadata?: Record<string, unknown>;
  initialMessages?: SessionMessage[];
}

export interface UpdateSessionParams {
  title?: string;
  status?: SessionStatus;
  metadata?: Record<string, unknown>;
}

export interface SessionQuery {
  status?: SessionStatus;
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'updatedAt' | 'lastActivityAt';
  sortOrder?: 'asc' | 'desc';
}

export interface ISessionManager {
  initialize(): Promise<unknown>;
  createSession(params?: CreateSessionParams): Promise<Session>;
  getSession(sessionId: string): Promise<Session | null>;
  updateSession(sessionId: string, params: UpdateSessionParams): Promise<Session | null>;
  deleteSession(sessionId: string): Promise<boolean>;
  querySessions(query?: SessionQuery): Promise<Session[]>;
  addMessage(sessionId: string, message: Omit<SessionMessage, 'id' | 'timestamp'>): Promise<SessionMessage>;
  getMessageHistory(sessionId: string, limit?: number): Promise<SessionMessage[]>;
  deleteMessage(sessionId: string, messageId: string): Promise<boolean>;
  restoreSession(sessionId: string): Promise<Session | null>;
  restoreAllSessions(): Promise<number>;
  cleanupExpiredSessions(ttlDays?: number): Promise<number>;
  getStats(): Promise<SessionStats>;
  destroy(): Promise<void>;
}

export interface SessionStats {
  totalSessions: number;
  activeSessions: number;
  totalMessages: number;
  oldestSession?: string;
  newestSession?: string;
}

export let globalSessionManager: ISessionManager | null = null;

export function setGlobalSessionManager(manager: ISessionManager): void {
  globalSessionManager = manager;
}

export function getGlobalSessionManager(): ISessionManager {
  if (!globalSessionManager) {
    throw new Error('Global SessionManager not initialized');
  }
  return globalSessionManager;
}

export default ISessionManager;
