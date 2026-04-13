/**
 * RuntimeFacade Types - 类型定义
 */

import type { Attachment } from '../bridges/types.js';
import type { Session, ISessionManager } from '../orchestration/session-types.js';

// 进度报告
export interface ProgressReport {
  overall: number;
  activeAgents: string[];
  pending: number;
  completed: number;
  failed: number;
}

// ─── Session alias for backward compatibility ─────────────────────────────
/** @deprecated Use Session from session-types.ts directly */
export type SessionInfo = Session;

// ─── Extended ISessionManager for runtime-specific needs ─────────────────────────────
export interface IRuntimeSessionManager extends ISessionManager {
  // Inherited from ISessionManager, no additional methods needed
  // This is just a type alias to make the intent clearer
}

// ─── Legacy ISessionManager interface (deprecated) ─────────────────────────────
/** @deprecated Use ISessionManager from session-types.ts */
export interface ISessionManagerLegacy {
  createSession(projectPath: string, name?: string): Session | Promise<Session>;
  getSession(sessionId: string): Session | undefined;
  getCurrentSession(): Session | null;
  setCurrentSession(sessionId: string): boolean;
  listSessions(): Session[];
  addMessage(sessionId: string, role: string, content: string, metadata?: { attachments?: Attachment[] }): Promise<{ id: string; timestamp: string } | null>;
  getMessages(
    sessionId: string,
    limit?: number,
  ): Array<{
    id: string;
    role: string;
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
    attachments?: Attachment[];
  }>;
  deleteSession(sessionId: string): boolean;
  pauseSession?(sessionId: string): boolean;
  resumeSession?(sessionId: string): boolean;
  updateContext?(sessionId: string, context: Record<string, unknown>): boolean;
  compressContext?(sessionId: string, options?: { summarizer?: unknown; force?: boolean }): Promise<string>;
  getCompressionStatus?(sessionId: string): { compressed: boolean; summary?: string; originalCount?: number };
  isPaused?(sessionId: string): boolean;
  /** Append turn digest with tags when finish_reason=stop */
  appendDigest?(sessionId: string, message: {
    id: string;
    role: string;
    content: string;
    timestamp: string;
  }, tags: string[], agentId?: string, mode?: string): Promise<void>;
  syncProjectionFromLedger?(sessionId: string, options?: {
    agentId?: string;
    mode?: string;
    source?: string;
  }): Promise<{
    applied: boolean;
    reason: string;
    messageCount?: number;
  }>;
}

// Re-export Session from session-types
export type { Session } from '../orchestration/session-types.js';
