/**
 * Quota Types - 基于 Phase 0.1 契约的配额类型定义
 * 
 * @see docs/contracts/AGENT_RUNTIME_CONTRACT_V1.md
 */

/**
 * 配额策略 V1
 * 优先级：workflowQuota > projectQuota > defaultQuota
 */
export interface QuotaPolicyV1 {
  /** 项目级配额上限 */
  projectQuota?: number;
  /** workflow 级配额（按 workflowId） */
  workflowQuota?: Record<string, number>;
}

/**
 * Agent 配置 V1（静态配置模板）
 * 统一入口，合并三处现有 AgentConfig，按职责分层
 */
export interface AgentConfigV1 {
  // === 核心标识 ===
  id: string;
  name: string;
  role: 'executor' | 'orchestrator' | 'reviewer' | 'tool';
  
  // === 配额 ===
  defaultQuota: number;      // 默认并发上限（>=1）
  quotaPolicy?: QuotaPolicyV1; // 可选：project/workflow 双层覆盖
  
  // === 执行层 ===
  execution: {
    provider: string;
    model?: string;
    systemPrompt?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
    permissionMode?: 'default' | 'autoEdit' | 'yolo' | 'plan';
  };
  
  // === 运行时层 ===
  runtime: {
    port?: number;
    command?: string;
    args?: string[];
    autoRestart?: boolean;
    maxRestarts?: number;
    restartBackoffMs?: number;
    healthCheckIntervalMs?: number;
    healthCheckTimeoutMs?: number;
    heartbeatTimeoutMs?: number;
  };
  
  // === 元数据 ===
  metadata?: Record<string, unknown>;
}

/**
 * Runtime 实例 V1（动态实例）
 */
export interface RuntimeInstanceV1 {
  instanceId: string;       // 唯一实例 ID
  agentConfigId: string;    // 关联的 AgentConfigV1.id
  status: RuntimeStatus;
  
  // === 上下文 ===
  fingerSessionId?: string;
  workflowId?: string;
  taskId?: string;
  
  // === 状态 ===
  queuePosition?: number;   // 排队位置（queued 时有效）
  queuedCount?: number;     // 该 agentType 当前排队总数
  startedAt?: number;
  
  // === 运行时 ===
  pid?: number;
  port?: number;
  
  // === 摘要 ===
  summary?: string;
  
  // === 结束 ===
  endedAt?: number;
  finalStatus?: 'completed' | 'failed' | 'interrupted';
  errorReason?: string;
}

/**
 * Runtime 状态枚举
 */
export type RuntimeStatus =
  | 'queued'           // 排队中
  | 'running'          // 运行中
  | 'waiting_input'    // 等待用户输入
  | 'completed'        // 正常结束
  | 'failed'           // 异常结束
  | 'interrupted';     // 被中断

/**
 * 会话绑定 V1
 */
export interface SessionBindingV1 {
  fingerSessionId: string;
  agentId: string;
  provider: string;
  providerSessionId: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

/**
 * 配额解析结果
 */
export interface QuotaResolution {
  effectiveQuota: number;
  source: 'workflow' | 'project' | 'default';
}

/**
 * 获取有效配额
 * 优先级：workflowQuota > projectQuota > defaultQuota
 */
export function getEffectiveQuota(
  config: AgentConfigV1,
  workflowId?: string
): QuotaResolution {
  // 1. 检查 workflow 级配额
  if (workflowId && config.quotaPolicy?.workflowQuota?.[workflowId]) {
    return {
      effectiveQuota: config.quotaPolicy.workflowQuota[workflowId],
      source: 'workflow',
    };
  }
  
  // 2. 检查 project 级配额
  if (config.quotaPolicy?.projectQuota) {
    return {
      effectiveQuota: config.quotaPolicy.projectQuota,
      source: 'project',
    };
  }
  
  // 3. 使用默认配额
  return {
    effectiveQuota: config.defaultQuota ?? 1,
    source: 'default',
  };
}
