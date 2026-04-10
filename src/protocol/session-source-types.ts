/**
 * Session Source Types - Session 来源标签类型定义（唯一真源）
 *
 * SessionSource 用于追溯 session 来源和创建上下文
 * 必填字段：source、createdAt、ownerWorkerId
 *
 * @see Docs/operation-event-communication-architecture.md
 */

// ─── Session Source 枚举 ───────────────────────────────────────

/**
 * Session 来源类型
 */
export type SessionSourceType =
  | 'cli'       // CLI 命令行
  | 'webui'     // Web UI
  | 'vscode'    // VSCode 扩展
  | 'heartbeat' // Heartbeat 定时任务
  | 'subagent'; // Sub-agent 派发

/**
 * Sub-agent 来源类型
 */
export type SubAgentSourceType =
  | 'dispatch'  // 任务派发
  | 'review'    // Review 阶段
  | 'compact';  // Memory 压缩

// ─── SessionSource Schema ───────────────────────────────────────

/**
 * Session Source Schema
 *
 * 必填字段：source、createdAt、ownerWorkerId
 */
export interface SessionSource {
  /** Session 来源类型（必填） */
  source: SessionSourceType;

  /** Sub-agent 来源详情（仅当 source='subagent' 时必填） */
  subAgentSource?: {
    /** Sub-agent 类型 */
    type: SubAgentSourceType;
    /** 父 thread ID */
    parentThreadId: string;
    /** 层级深度 */
    depth: number;
    /** Agent 角色 */
    agentRole?: 'system' | 'project';
    /** Agent 名称（可选） */
    agentName?: string;
  };

  /** 创建时间（必填） */
  createdAt: string;

  /** 所属 worker（必填） */
  ownerWorkerId: string;

  /** 创建者信息（可选） */
  creator?: {
    /** 创建者类型 */
    type: 'user' | 'system' | 'agent';
    /** 创建者 ID */
    id: string;
    /** 创建者路径 */
    path?: string;
  };

  /** 创建原因（可选） */
  reason?: string;
}

// ─── SessionSource 工具函数 ─────────────────────────────────────

export const SessionSourceUtils = {
  /**
   * 创建 CLI SessionSource
   */
  createCli(ownerWorkerId: string, userId?: string): SessionSource {
    return {
      source: 'cli',
      createdAt: new Date().toISOString(),
      ownerWorkerId,
      creator: userId ? { type: 'user', id: userId } : undefined,
    };
  },

  /**
   * 创建 WebUI SessionSource
   */
  createWebui(ownerWorkerId: string, userId?: string): SessionSource {
    return {
      source: 'webui',
      createdAt: new Date().toISOString(),
      ownerWorkerId,
      creator: userId ? { type: 'user', id: userId } : undefined,
    };
  },

  /**
   * 创建 VSCode SessionSource
   */
  createVscode(ownerWorkerId: string, userId?: string): SessionSource {
    return {
      source: 'vscode',
      createdAt: new Date().toISOString(),
      ownerWorkerId,
      creator: userId ? { type: 'user', id: userId } : undefined,
    };
  },

  /**
   * 创建 Heartbeat SessionSource
   */
  createHeartbeat(ownerWorkerId: string, reason?: string): SessionSource {
    return {
      source: 'heartbeat',
      createdAt: new Date().toISOString(),
      ownerWorkerId,
      creator: { type: 'system', id: 'heartbeat-scheduler' },
      reason,
    };
  },

  /**
   * 创建 Sub-agent SessionSource
   */
  createSubagent(
    ownerWorkerId: string,
    subAgentType: SubAgentSourceType,
    parentThreadId: string,
    depth: number,
    options?: {
      agentRole?: 'system' | 'project';
      agentName?: string;
      reason?: string;
    },
  ): SessionSource {
    return {
      source: 'subagent',
      createdAt: new Date().toISOString(),
      ownerWorkerId,
      subAgentSource: {
        type: subAgentType,
        parentThreadId,
        depth,
        agentRole: options?.agentRole,
        agentName: options?.agentName,
      },
      creator: {
        type: 'agent',
        id: parentThreadId,
      },
      reason: options?.reason,
    };
  },

  /**
   * 验证 SessionSource 必填字段
   */
  validate(sessionSource: SessionSource): { valid: boolean; missing: string[] } {
    const missing: string[] = [];
    if (!sessionSource.source) missing.push('source');
    if (!sessionSource.createdAt) missing.push('createdAt');
    if (!sessionSource.ownerWorkerId) missing.push('ownerWorkerId');

    // 当 source='subagent' 时，subAgentSource 必填
    if (sessionSource.source === 'subagent' && !sessionSource.subAgentSource) {
      missing.push('subAgentSource');
    }

    if (sessionSource.subAgentSource) {
      if (!sessionSource.subAgentSource.type) missing.push('subAgentSource.type');
      if (!sessionSource.subAgentSource.parentThreadId) missing.push('subAgentSource.parentThreadId');
      if (sessionSource.subAgentSource.depth === undefined) missing.push('subAgentSource.depth');
    }

    return { valid: missing.length === 0, missing };
  },

  /**
   * 判断是否为 Sub-agent Session
   */
  isSubagent(sessionSource: SessionSource): boolean {
    return sessionSource.source === 'subagent';
  },

  /**
   * 判断是否为 Heartbeat Session
   */
  isHeartbeat(sessionSource: SessionSource): boolean {
    return sessionSource.source === 'heartbeat';
  },

  /**
   * 判断是否为用户创建的 Session
   */
  isUserCreated(sessionSource: SessionSource): boolean {
    return ['cli', 'webui', 'vscode'].includes(sessionSource.source);
  },

  /**
   * 获取层级深度（非 subagent 返回 0）
   */
  getDepth(sessionSource: SessionSource): number {
    return sessionSource.subAgentSource?.depth ?? 0;
  },

  /**
   * 获取父 thread ID（非 subagent 返回 null）
   */
  getParentThreadId(sessionSource: SessionSource): string | null {
    return sessionSource.subAgentSource?.parentThreadId ?? null;
  },
};

// ─── Legacy Session 数据迁移规则 ───────────────────────────────

/**
 * Legacy Session 迁移规则
 *
 * - 旧 session 缺失 `ownerWorkerId`：自动填充为 `system-worker-default`
 * - 旧 session 缺失 `source`：自动填充为 `cli`
 * - 迁移逻辑幂等、可回放、不可静默失败
 */
export const LegacySessionMigration = {
  /**
   * 默认 ownerWorkerId（用于填充缺失字段）
   */
  DEFAULT_OWNER_WORKER_ID: 'system-worker-default',

  /**
   * 默认 source（用于填充缺失字段）
   */
  DEFAULT_SOURCE: 'cli' as SessionSourceType,

  /**
   * 迁移旧 session 数据（补齐缺失字段）
   */
  migrate(session: Record<string, unknown>): SessionSource {
    // 幂等迁移：已存在则跳过
    const existingSource = session.source as SessionSource | undefined;
    if (existingSource && SessionSourceUtils.validate(existingSource).valid) {
      return existingSource;
    }

    // 补齐缺失字段
    return {
      source: (session.source as SessionSourceType) || LegacySessionMigration.DEFAULT_SOURCE,
      createdAt: (session.createdAt as string) || new Date().toISOString(),
      ownerWorkerId: (session.ownerWorkerId as string) || LegacySessionMigration.DEFAULT_OWNER_WORKER_ID,
      subAgentSource: session.subAgentSource as SessionSource['subAgentSource'],
      creator: session.creator as SessionSource['creator'],
      reason: session.reason as string,
    };
  },

  /**
   * 判断是否需要迁移（检查缺失字段）
   */
  needsMigration(session: Record<string, unknown>): boolean {
    const existingSource = session.source as SessionSource | undefined;
    if (!existingSource) return true;
    const validation = SessionSourceUtils.validate(existingSource);
    return !validation.valid;
  },
};
