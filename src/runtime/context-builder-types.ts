/**
 * Context Builder Types
 *
 * Context Builder 负责动态构建会话上下文
 * - 读取 MEMORY.md 作为强制性长期记忆
 * - 使用 ledger 工具（只读/搜索/index权限）查询历史
 * - 模型辅助排序
 * - 任务边界分组 + 预算控制
 */

/**
 * 任务块：一次完整用户请求到结束的会话片段
 */
export interface TaskBlock {
  /** 任务 ID（通常是 turn_start 到 turn_complete 之间的消息） */
  id: string;
  /** 开始时间戳 */
  startTime: number;
  /** 结束时间戳 */
  endTime: number;
  /** 时间戳 ISO 格式 */
  startTimeIso: string;
  endTimeIso: string;
  /** 消��列表 */
  messages: TaskMessage[];
  /** Token 数量估算 */
  tokenCount: number;
  /** 相关性得分（模型排序结果） */
  relevanceScore?: number;
  /** 任务摘要 */
  summary?: string;
  /**
   * 分类标签（从 ledger metadata 提取）
   * 用于上下文聚合和相关性排序
   */
  tags?: string[];
  /**
   * 主题分类（粗粒度）
   * 从 ledger metadata.topic 提取
   */
  topic?: string;
}

/**
 * 任务消息
 */
export type ContextMessageZone = 'working_set' | 'historical_memory';

export interface TaskMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  timestampIso: string;
  tokenCount: number;
  /** Original message ID from ledger payload.message_id */
  messageId?: string;
  /** Message metadata (reasoning/source/session pointers etc.) */
  metadata?: Record<string, unknown>;
  /**
   * Attachments in context are always compact placeholders.
   * We never include full image/file payload in built context to keep model input safe/portable.
   */
  attachments?: {
    count: number;
    summary: string;
  };
  /** 所属上下文分区 */
  contextZone?: ContextMessageZone;
  /** 是否属于当前轮次（最后一条用户输入） */
  isCurrentTurn?: boolean;
}

/**
 * Context builder 构建模式
 *
 * - minimal:    最轻模式 — 保持原始顺序，只移除与最新用户输入无关的 task
 * - moderate:   中等模式 — 移除无关 task 后，从历史中补充相关性高的 task（单个可超释放量，总预算内即可）
 * - aggressive: 激进模式 — 完全按相关性重排所有 task
 */
export type ContextBuildMode = 'minimal' | 'moderate' | 'aggressive';

/**
 * 上下文构建选项
 */
export interface ContextBuildOptions {
  /** 目标上下文预算（tokens），默认为模型上下文窗口的 85% */
  targetBudget: number;
  /** 构建模式 */
  buildMode?: ContextBuildMode;
  /** 强制包含 MEMORY.md */
  includeMemoryMd?: boolean;
  /** MEMORY.md 路径（默认从项目根目录读取） */
  memoryMdPath?: string;
  /** 任务分组是否启用 */
  enableTaskGrouping?: boolean;
  /** 模型排序开关：true=生效重排，'dryrun'=只计算不重排 */
  enableModelRanking?: boolean | 'dryrun';
  /** 排序模型 providerId（从 user-settings.aiProviders 读取） */
  rankingProviderId?: string;
  /**
   * Rebuild trigger hint.
   * - bootstrap_first: first rebuild when history is empty (prefer tag-selection by model)
   * - history_context_zero: history zone missing, force rebuild
   * - manual: explicit tool-triggered rebuild
   * - default: normal rebuild path
   */
  rebuildTrigger?: 'bootstrap_first' | 'history_context_zero' | 'manual' | 'default';
  /** 是否启用 embedding recall 作为历史候选召回层 */
  enableEmbeddingRecall?: boolean;
  /** embedding recall 候选数量 */
  embeddingTopK?: number;
  /**
   * Prefer compact task digests from compact-memory replacement_history for historical blocks.
   * Working set (latest task) still comes from live session snapshot.
   */
  preferCompactHistory?: boolean;
}

/**
 * 上下文构建结果
 */
export interface ContextBuildResult {
  /** 构建成功 */
  ok: true;
  /** 最终的消息列表 */
  messages: TaskMessage[];
  /** 总 token 数 */
  totalTokens: number;
  /** MEMORY.md 是否已包含 */
  memoryMdIncluded: boolean;
  /** 任务块数量 */
  taskBlockCount: number;
  /** 被过滤掉的任务块数量 */
  filteredTaskBlockCount: number;
  /** 排序后的任务块列表 */
  rankedTaskBlocks: TaskBlock[];
  /** 构建时间戳 */
  buildTimestamp: string;
  /** 构建元数据 */
  metadata: {
    /** 原始任务块总数 */
    rawTaskBlockCount: number;
    /** 时间窗口过滤后的数量（已弃用，当前固定为 0） */
    timeWindowFilteredCount: number;
    /** 预算截断的任务块数量 */
    budgetTruncatedCount: number;
    /** 因预算被排除的任务块（按相关性顺序后仍未能放入） */
    budgetTruncatedTasks?: Array<{
      id: string;
      tokenCount: number;
      startTimeIso: string;
      topic?: string;
      tags?: string[];
      summary?: string;
    }>;
    /** 上下文预算 */
    targetBudget: number;
    /** 实际使用 */
    actualTokens: number;
    /** 构建模式 */
    buildMode?: ContextBuildMode;
    /** 移除的无关 task 数量（minimal/moderate） */
    removedIrrelevantCount?: number;
    /** 补充的历史 task 数量（moderate） */
    supplementedCount?: number;
    /** 移除释放的 token 数 */
    removedTokens?: number;
    /** 补充消耗的 token 数 */
    supplementedTokens?: number;
    /** Ranking 是否执行（含 dryrun） */
    rankingExecuted?: boolean;
    /** Ranking 模式 */
    rankingMode?: 'off' | 'active' | 'dryrun';
    /** Ranking provider ID */
    rankingProviderId?: string;
    /** Ranking provider model（仅观测） */
    rankingProviderModel?: string;
    /** Ranking 执行/跳过原因 */
    rankingReason?: string;
    /** Tag selection（bootstrap-first）是否执行 */
    tagSelectionExecuted?: boolean;
    /** Tag selection provider ID */
    tagSelectionProviderId?: string;
    /** Tag selection provider model */
    tagSelectionProviderModel?: string;
    /** Tag selection 执行/跳过原因 */
    tagSelectionReason?: string;
    /** Tag selection 结果 tags */
    selectedTags?: string[];
    /** Tag selection 结果 task IDs */
    selectedTaskIds?: string[];
    /** Embedding recall 是否执行 */
    embeddingRecallExecuted?: boolean;
    /** Embedding recall 候选数量 */
    embeddingCandidateCount?: number;
    /** Embedding recall 执行/跳过原因 */
    embeddingRecallReason?: string;
    /** Embedding index 文件路径 */
    embeddingIndexPath?: string;
    /** Embedding recall 错误（仅观测） */
    embeddingRecallError?: string;
    /** 工作集 task block 数量（当前 task 区） */
    workingSetTaskBlockCount?: number;
    /** 历史记忆区 task block 数量 */
    historicalTaskBlockCount?: number;
    /** 工作集消息数 */
    workingSetMessageCount?: number;
    /** 历史记忆区消息数 */
    historicalMessageCount?: number;
    /** 工作集 token 数 */
    workingSetTokens?: number;
    /** 历史记忆区 token 数 */
    historicalTokens?: number;
    /** 工作集 block IDs */
    workingSetBlockIds?: string[];
    /** 历史记忆区 block IDs */
    historicalBlockIds?: string[];
  };
}

/**
 * 排序输出格式（模型返回）
 */
export interface RankingOutput {
  /** 任务块 ID 列表，按相关性排序 */
  rankedTaskIds: string[];
  /** 每个任务块的摘要（可选） */
  summaries?: Record<string, string>;
}
