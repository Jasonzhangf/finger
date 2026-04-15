/**
 * Session Types - 会话相关类型定义（唯一真源）
 *
 * Ledger-Session 一体化架构：
 * - Ledger 负责 append-only 持久化流水
 * - Session messages 是运行时消费的唯一会话快照（projection）
 * - 每次写入先落 Ledger，再同步更新 Session snapshot
 */

import type { Attachment } from '../runtime/events.js';

// ─── SessionStatus 枚举 ────────────────────────────────────

export enum SessionStatus {
  ACTIVE = 'active',
  PAUSED = 'paused',
  ARCHIVED = 'archived',
  CLOSED = 'closed',
}

// ─── Session 接口（唯一真源）───────────────────────────────

/** Session 元数据 + Ledger 指针 */
export interface Session {
  id: string;
  name: string;
  title?: string; // 兼容旧版（name 的别名）
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  lastActivityAt?: string; // 兼容旧版
  status?: SessionStatus; // 兼容旧版
  messageCount?: number; // 兼容旧版

  /**
   * Runtime session snapshot (projection).
   * Runtime context/history consumption should read from this field.
   * Ledger remains append-only canonical timeline for persistence/query.
   */
  messages: SessionMessage[];

  activeWorkflows: string[];
  context: Record<string, unknown>;

  // ─── Ledger 指针字段 ────────────────────────────────

  /** Ledger 文件根目录（相对于 session 存储目录） */
  ledgerPath: string;

  /** 最新压缩块在 compact-memory.jsonl 中的行号（0-based），无压缩时为 -1 */
  latestCompactIndex: number;

  /** 当前有效窗口中原始消息在 context-ledger.jsonl 的起始行号（0-based） */
  originalStartIndex: number;

  /** 当前有效窗口中原始消息在 context-ledger.jsonl 的结束行号（0-based） */
  originalEndIndex: number;

  /** 当前 session 窗口的 token 总数估算 */
  totalTokens: number;

  /** Ledger 最后写入的行号（用于一致性检测和崩溃恢复） */
  ledgerEndLine?: number;

  /**
   * 多轨（Multi-Track）支持
   * 默认 "track0"，兼容旧 session
   */
  track?: string;

  // ─── 双层指针（新架构）────────────────────────────────

  /**
   * 双层指针：Context History（已压缩） + Current History（活跃）
   * 用于支持 Kernel 重建上下文
   */
  pointers?: {
    /** 已压缩历史（compact-memory.jsonl） */
    contextHistory: {
      startLine: number;
      endLine: number;
      estimatedTokens: number;
    };
    /** 当前活跃消息（context-ledger.jsonl） */
    currentHistory: {
      startLine: number;
      endLine: number;
      estimatedTokens: number;
    };
  };

  // ─── 内存缓存（不持久化） ────────────────────────────────

  /**
   * 缓存的 session 视图，由 LedgerReader.buildSessionView() 构建。
   * 仅存在于内存中，不序列化到 JSON。
   */
  _cachedView?: import('../runtime/ledger-reader.js').SessionView;
}

export interface SessionMessage {
  id: string;
  ledgerLine?: number;  // Ledger slot_number for consistency check (0-based index in ledger file)
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  workflowId?: string;
  taskId?: string;
  attachments?: Attachment[];
  type?: 'text' | 'command' | 'plan_update' | 'task_update' | 'tool_call' | 'tool_result' | 'tool_error' | 'agent_step' | 'dispatch' | 'reasoning' | 'ledger_pointer';
  agentId?: string;
  toolName?: string;
  toolStatus?: 'success' | 'error';
  toolDurationMs?: number;
  toolInput?: unknown;
  toolOutput?: unknown;
  metadata?: Record<string, unknown>;
}

// ─── ISessionManager 接口（唯一真源）──────────────────────

export interface CreateSessionParams {
  title?: string;
  projectPath?: string;
  metadata?: Record<string, unknown>;
  initialMessages?: SessionMessage[];
}

export interface UpdateSessionParams {
  title?: string;
  name?: string;
  status?: SessionStatus;
  metadata?: Record<string, unknown>;
}

export interface SessionQuery {
  status?: SessionStatus;
  projectPath?: string;
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'updatedAt' | 'lastAccessedAt' | 'lastActivityAt';
  sortOrder?: 'asc' | 'desc';
}

export interface SessionStats {
  totalSessions: number;
  activeSessions: number;
  totalMessages: number;
  oldestSession?: string;
  newestSession?: string;
}

/**
 * ISessionManager - Session 管理唯一接口
 * 
 * 实现类：SessionManager (src/orchestration/session-manager.ts)
 */
export interface ISessionManager {
  initialize(): Promise<unknown>;
  createSession(projectPath: string, name?: string, options?: { allowReuse?: boolean }): Session;
  getSession(sessionId: string): Session | undefined;
  getCurrentSession(): Session | null;
  setCurrentSession(sessionId: string): boolean;
  listSessions(): Session[];
  getSessionSnapshot(sessionId: string): Session | undefined;
  getSessionMessageSnapshot(sessionId: string, previewLimit?: number): { messageCount: number; previewMessages: SessionMessage[]; lastMessageAt?: string };
  updateSession(sessionId: string, params: UpdateSessionParams): Session | undefined;
  deleteSession(sessionId: string): boolean;
  querySessions(query?: SessionQuery): Session[];
  addMessage(
    sessionId: string,
    role: SessionMessage['role'],
    content: string,
    metadata?: {
      workflowId?: string;
      taskId?: string;
      attachments?: unknown[];
      type?: SessionMessage['type'];
      agentId?: string;
      toolName?: string;
      toolStatus?: SessionMessage['toolStatus'];
      toolDurationMs?: number;
      toolInput?: unknown;
      toolOutput?: unknown;
      tags?: string[];
      topic?: string;
      timestamp?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<SessionMessage | null>;
  getMessages(sessionId: string, limit?: number): SessionMessage[];
  getMessageHistory(sessionId: string, limit?: number): SessionMessage[];
  deleteMessage(sessionId: string, messageId: string): boolean;
  restoreSession(sessionId: string): Session | null;
  resolveLedgerRootForSession?(sessionId: string): string | null;
  restoreAllSessions(): number;
  cleanupExpiredSessions(ttlDays?: number): number;
  getStats(): SessionStats;
  destroy(): void;
  pauseSession?(sessionId: string): boolean;
  resumeSession?(sessionId: string): boolean;
  isPaused?(sessionId: string): boolean;
  updateContext?(sessionId: string, context: Record<string, unknown>): boolean;
  compressContext?(sessionId: string, options?: { force?: boolean }): Promise<string>;
  getCompressionStatus?(sessionId: string): { compressed: boolean; summary?: string; originalCount?: number };
  appendDigest?(
    sessionId: string,
    message: {
      role: SessionMessage['role'];
      content: string;
      timestamp: string;
    },
    tags?: string[],
    agentId?: string,
    mode?: string,
  ): Promise<void>;
  syncProjectionFromLedger?(
    sessionId: string,
    options?: {
      agentId?: string;
      mode?: string;
      source?: string;
      maxTokens?: number;
      includeSummary?: boolean;
      force?: boolean;
    },
  ): Promise<{
    applied: boolean;
    reason: string;
    messageCount?: number;
    latestCompactIndex?: number;
    totalTokens?: number;
    success?: boolean;
    error?: string;
  }>;
  
  /**
   * Replace all messages in a session (for rebuild).
   * This is the ONLY way to update session history after rebuild.
   * Updates both memory snapshot AND main.json.
   * @returns true if session exists and messages were replaced
   */
  replaceMessages(sessionId: string, messages: SessionMessage[]): boolean;
}

// ─── Ledger 指针默认值 ────────────────────────────────────

/** Ledger 指针的默认初始值 */
export const LEDGER_POINTER_DEFAULTS = {
  ledgerPath: '',
  latestCompactIndex: -1,
  originalStartIndex: 0,
  originalEndIndex: 0,
  totalTokens: 0,
} as const;

/**
 * 为 Session 对象填充 Ledger 指针默认值（向后兼容旧 session）
 */
export function ensureLedgerPointers(session: Session): Session {
  if (!session.ledgerPath) {
    session.ledgerPath = LEDGER_POINTER_DEFAULTS.ledgerPath;
  }
  if (session.latestCompactIndex === undefined || session.latestCompactIndex === null) {
    session.latestCompactIndex = LEDGER_POINTER_DEFAULTS.latestCompactIndex;
  }
  if (session.originalStartIndex === undefined || session.originalStartIndex === null) {
    session.originalStartIndex = LEDGER_POINTER_DEFAULTS.originalStartIndex;
  }
  if (session.originalEndIndex === undefined || session.originalEndIndex === null) {
    session.originalEndIndex = LEDGER_POINTER_DEFAULTS.originalEndIndex;
  }
  if (session.totalTokens === undefined || session.totalTokens === null) {
    session.totalTokens = LEDGER_POINTER_DEFAULTS.totalTokens;
  }
  // 初始化新指针结构（如果不存在）
  if (!session.pointers) {
    session.pointers = {
      contextHistory: {
        startLine: 0,
        endLine: session.latestCompactIndex >= 0 ? session.latestCompactIndex : -1,
        estimatedTokens: 0,
      },
      currentHistory: {
        startLine: 0,
        endLine: 0,
        estimatedTokens: 0,
      },
    };
  }
  return session;
}
