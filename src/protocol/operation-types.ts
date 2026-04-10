/**
 * Operation Types - 操作层类型定义（唯一真源）
 *
 * Operation 是命令式语义：描述"请执行什么"
 * 必填字段：opId、from、to、intent、payload、timestamp
 *
 * @see Docs/operation-event-communication-architecture.md
 */

// ─── AgentPath 类型（借鉴 Codex）────────────────────────────────

/**
 * Agent 路径类型（类文件系统路径）
 *
 * 示例：
 * - "/root" → system coordinator
 * - "/root/finger-project-agent" → project executor
 * - "/root/finger-system-agent" → system coordinator（review 阶段也在此路径）
 */
export type AgentPath = string & { readonly __brand: unique symbol };

/**
 * AgentPath 工具函数
 */
export const AgentPathUtils = {
  /**
   * 创建根路径
   */
  root(): AgentPath {
    return '/root' as AgentPath;
  },

  /**
   * 创建 system coordinator 路径
   */
  systemCoordinator(): AgentPath {
    return '/root/finger-system-agent' as AgentPath;
  },

  /**
   * 创建 project executor 路径
   */
  projectExecutor(): AgentPath {
    return '/root/finger-project-agent' as AgentPath;
  },

  /**
   * 验证是否为合法 AgentPath
   */
  isValid(path: string): path is AgentPath {
    if (!path.startsWith('/root')) return false;
    const segments = path.split('/').filter(s => s.length > 0);
    if (segments.length < 1) return false;
    if (segments[0] !== 'root') return false;
    // 每个段只允许 lowercase + digits + underscore + hyphen
    for (let i = 1; i < segments.length; i++) {
      if (!/^[a-z0-9_-]+$/.test(segments[i])) return false;
    }
    return true;
  },

  /**
   * 获取末端名称
   */
  name(path: AgentPath): string {
    if (path === '/root') return 'root';
    const segments = path.split('/').filter(s => s.length > 0);
    return segments[segments.length - 1] || 'root';
  },

  /**
   * 获取父路径
   */
  parent(path: AgentPath): AgentPath | null {
    if (path === '/root') return null;
    const segments = path.split('/').filter(s => s.length > 0);
    if (segments.length <= 1) return this.root();
    return `/${segments.slice(0, -1).join('/')}` as AgentPath;
  },

  /**
   * 创建子路径
   */
  join(parent: AgentPath, childName: string): AgentPath {
    if (!/^[a-z0-9_-]+$/.test(childName)) {
      throw new Error(`Invalid agent name: ${childName}. Must use only lowercase letters, digits, underscores, and hyphens`);
    }
    return `${parent}/${childName}` as AgentPath;
  },

  /**
   * 判断是否为 system coordinator
   */
  isSystemCoordinator(path: AgentPath): boolean {
    return path === '/root' || path === '/root/finger-system-agent';
  },

  /**
   * 判断是否为 project executor
   */
  isProjectExecutor(path: AgentPath): boolean {
    return path === '/root/finger-project-agent';
  },
};

// ─── Operation Intent 枚举 ──────────────────────────────────────

/**
 * 操作意图枚举
 */
export type OperationIntent =
  | 'dispatch_task'       // 派发任务
  | 'interrupt'           // 中断任务
  | 'query_status'        // 查询状态
  | 'update_config'       // 更新配置
  | 'inter_agent_message' // Agent 间通信
  | 'control_command'     // 控制命令（pause/resume/stop）
  | 'user_input';         // 用户输入

/**
 * 控制命令类型
 */
export type ControlCommandType = 'pause' | 'resume' | 'stop';

// ─── Operation Schema ───────────────────────────────────────────

/**
 * Operation Schema（操作层）
 *
 * 必填字段：opId、from、to、intent、payload、timestamp
 * 可选字段：blocking、timeoutMs、ownerWorkerId
 */
export interface Operation {
  /** 唯一标识，用于追溯（必填） */
  opId: string;

  /** 发送者路径（必填） */
  from: AgentPath;

  /** 接收者路径（必填） */
  to: AgentPath;

  /** 操作意图枚举（必填） */
  intent: OperationIntent;

  /** 操作参数（必填） */
  payload: OperationPayload;

  /** ISO8601 时间戳（必填） */
  timestamp: string;

  /** 是否阻塞式执行（可选） */
  blocking?: boolean;

  /** 超时时间（可选） */
  timeoutMs?: number;

  /** 所属 worker（可选，用于 ownership 校验） */
  ownerWorkerId?: string;
}

/**
 * Operation Payload 类型映射
 */
export interface OperationPayloadMap {
  dispatch_task: DispatchTaskPayload;
  interrupt: InterruptPayload;
  query_status: QueryStatusPayload;
  update_config: UpdateConfigPayload;
  inter_agent_message: InterAgentMessagePayload;
  control_command: ControlCommandPayload;
  user_input: UserInputPayload;
}

export type OperationPayload = OperationPayloadMap[OperationIntent];

// ─── Payload 定义 ───────────────────────────────────────────────

export interface DispatchTaskPayload {
  taskId: string;
  taskTitle?: string;
  taskDescription?: string;
  projectPath?: string;
  sessionId?: string;
  priority?: number;
  dependencies?: string[];
}

export interface InterruptPayload {
  dispatchId?: string;
  taskId?: string;
  reason?: string;
}

export interface QueryStatusPayload {
  targetAgentId?: string;
  queryType?: 'full' | 'summary' | 'active_ops';
}

export interface UpdateConfigPayload {
  configKey: string;
  configValue: unknown;
  scope?: 'global' | 'project' | 'session';
}

export interface InterAgentMessagePayload {
  messageType: 'request' | 'response' | 'notification';
  content: unknown;
  requiresResponse?: boolean;
}

export interface ControlCommandPayload {
  command: ControlCommandType;
  targetDispatchId?: string;
  reason?: string;
}

export interface UserInputPayload {
  content: string;
  attachments?: Array<{
    type: 'image' | 'file' | 'skill' | 'mention';
    path?: string;
    url?: string;
    name?: string;
  }>;
}

// ─── Operation 工具函数 ─────────────────────────────────────────

export const OperationUtils = {
  /**
   * 创建 Operation ID
   */
  generateOpId(): string {
    return `op-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  },

  /**
   * 创建基础 Operation
   */
  create(
    from: AgentPath,
    to: AgentPath,
    intent: OperationIntent,
    payload: OperationPayload,
    options?: {
      blocking?: boolean;
      timeoutMs?: number;
      ownerWorkerId?: string;
    },
  ): Operation {
    return {
      opId: this.generateOpId(),
      from,
      to,
      intent,
      payload,
      timestamp: new Date().toISOString(),
      ...options,
    };
  },

  /**
   * 验证 Operation 必填字段
   */
  validate(op: Operation): { valid: boolean; missing: string[] } {
    const missing: string[] = [];
    if (!op.opId) missing.push('opId');
    if (!op.from) missing.push('from');
    if (!op.to) missing.push('to');
    if (!op.intent) missing.push('intent');
    if (!op.payload) missing.push('payload');
    if (!op.timestamp) missing.push('timestamp');
    return { valid: missing.length === 0, missing };
  },

  /**
   * 验证 AgentPath 格式
   */
  validateAgentPath(path: string): { valid: boolean; error?: string } {
    if (!AgentPathUtils.isValid(path)) {
      return { valid: false, error: `Invalid AgentPath: ${path}. Must start with /root and use only lowercase, digits, underscore, hyphen` };
    }
    return { valid: true };
  },
};
