/**
 * Session Types - 会话相关类型定义
 *
 * Ledger-Session 一体化架构：
 * - Ledger 负责 append-only 持久化流水
 * - Session messages 是运行时消费的唯一会话快照（projection）
 * - 每次写入先落 Ledger，再同步更新 Session snapshot
 */

import type { Attachment } from '../runtime/events.js';

/** Session 元数据 + Ledger 指针 */
export interface Session {
  id: string;
  name: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;

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

  // ─── 内存缓存（不持久化） ────────────────────────────────

  /**
   * 缓存的 session 视图，由 LedgerReader.buildSessionView() 构建。
   * 仅存在于内存中，不序列化到 JSON。
   */
  _cachedView?: import('../runtime/ledger-reader.js').SessionView;
}

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'orchestrator';
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
  return session;
}
