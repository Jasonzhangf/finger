/**
 * Session Types - 会话相关类型定义
 *
 * Ledger-Session 一体化架构：
 * - Ledger 是唯一数据真源 (SSOT)
 * - Session 是动态视图，缓存当前有效窗口
 * - messages 字段已废弃，仅保留向后兼容
 */

import type { Attachment } from '../runtime/events.js';

/**
 * Session 元数据 + Ledger 指针
 *
 * Session 不再存储 messages 数组作为真源。
 * 所有消息写入 Ledger JSONL，Session 只保存指针和缓存视图。
 */
export interface Session {
  id: string;
  name: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;

  /**
   * @deprecated 消息已迁移至 Ledger (context-ledger.jsonl)。
   * 此字段仅保留向后兼容，新代码不应直接读写。
   * 将在 finger-249.7 中完全移除。
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
