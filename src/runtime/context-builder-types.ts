/**
 * Context Builder Types
 *
 * Context Builder 负责动态构建会话上下文
 * - 读取 MEMORY.md 作为强制性长期记忆
 * - 使用 ledger 工具（只读/搜索/index权限）查询历史
 * - 24小时半衰期过滤 + 模型辅助排序
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
  /** 消息列表 */
  messages: TaskMessage[];
  /** Token 数量估算 */
  tokenCount: number;
  /** 相关性得分（模型排序结果） */
  relevanceScore?: number;
  /** 任务摘要 */
  summary?: string;
}

/**
 * 任务消息
 */
export interface TaskMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'orchestrator';
  content: string;
  timestamp: number;
  timestampIso: string;
  tokenCount: number;
  /** 是否属于当前轮次（最后一条用户输入） */
  isCurrentTurn?: boolean;
}

/**
 * 时间窗口过滤选项
 */
export interface TimeWindowFilterOptions {
  /** 当前时间戳 */
  nowMs: number;
  /** 半衰期（毫秒），默认 24 小时 */
  halfLifeMs?: number;
  /** 超过半衰期后，相关性阈值（0-1），低于此值的丢弃 */
  overThresholdRelevance?: number;
}

/**
 * 上下文构建选项
 */
export interface ContextBuildOptions {
  /** 目标上下文预算（tokens），默认为模型上下文窗口的 85% */
  targetBudget: number;
  /** 强制包含 MEMORY.md */
  includeMemoryMd?: boolean;
  /** MEMORY.md 路径（默认从项目根目录读取） */
  memoryMdPath?: string;
  /** 时间窗口过滤选项 */
  timeWindow?: TimeWindowFilterOptions;
  /** 任务分组是否启用 */
  enableTaskGrouping?: boolean;
  /** 模型排序是否启用 */
  enableModelRanking?: boolean;
  /** 排序模型（默认 qwen3.5-plus） */
  rankingModel?: string;
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
    /** 时间窗口过滤后的数量 */
    timeWindowFilteredCount: number;
    /** 预算截断的任务块数量 */
    budgetTruncatedCount: number;
    /** 上下文预算 */
    targetBudget: number;
    /** 实际使用 */
    actualTokens: number;
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
