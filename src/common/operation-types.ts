/**
 * Operation Types - 指令驱动架构
 * 
 * Operation 是任务派发的唯一通道，替代旧的"发消息"机制。
 * 
 * 核心原则：
 * - 持久化：写入 ~/.finger/runtime/operation-log.jsonl
 * - 幂等：每个 opId 唯一，重复发送不重复执行
 * - 不经过 Chat 队列：独立路由，不干扰 pending_input
 */

import { logger } from '../core/logger.js';

const log = logger.module('OperationTypes');

/**
 * Operation 类型枚举
 */
export enum OpType {
  // 任务控制
  EPIC_CREATE = 'epic.create',
  EPIC_ASSIGN = 'epic.assign',    // 指派 assignee（不改 current）
  EPIC_CLAIM = 'epic.claim',      // agent 认领任务
  EPIC_START = 'epic.start',      // 开始执行（设为 current）
  EPIC_STOP = 'epic.stop',        // 停止执行
  EPIC_RESUME = 'epic.resume',    // 恢复执行
  EPIC_UPDATE = 'epic.update',    // 修改 epic 内容
  EPIC_PRIORITY = 'epic.priority', // 调整优先级
  EPIC_CLOSE = 'epic.close',      // 关闭 epic

  // 紧急抢占
  AGENT_PREEMPT = 'agent.preempt', // 停止当前任务，切换到新任务

  // 状态查询
  AGENT_STATUS = 'agent.status',
  PROJECT_LIST = 'project.list',
  TEAM_STATUS = 'team.status',

  // 交互（走 Chat 通道，不阻塞任务）
  AGENT_QUERY = 'agent.query',
}

/**
 * Operation 基础接口
 */
export interface Operation {
  opId: string;                   // 唯一标识（幂等）
  type: OpType;                   // 指令类型
  sourceAgentId: string;          // 发送方 Agent ID
  targetAgentId: string;          // 接收方 Agent ID
  projectPath?: string;           // 项目路径（可选）
  epicId?: string;                // Epic ID（可选）
  taskId?: string;                // Task ID（可选）
  payload?: Record<string, unknown>; // 附加数据
  createdAt: number;              // 创建时间戳
  status?: 'pending' | 'sent' | 'acknowledged' | 'completed' | 'failed';
  acknowledgedAt?: number;
  completedAt?: number;
  error?: string;
}

/**
 * Epic Assign Payload
 */
export interface EpicAssignPayload {
  assigneeAgentId?: string;       // 指派给哪个 Agent
  assigneeWorkerId?: string;      // 指派给哪个 Worker
  force?: boolean;                // 是否强制指派（即使 agent busy）
}

/**
 * Epic Claim Payload
 */
export interface EpicClaimPayload {
  claimByAgentId: string;
  claimByWorkerId?: string;
}

/**
 * Epic Start Payload
 */
export interface EpicStartPayload {
  boundSessionId?: string;        // 绑定的 Session ID
  resumeFromCheckpoint?: boolean; // 是否从 checkpoint 恢复
}

/**
 * Agent Preempt Payload
 */
export interface AgentPreemptPayload {
  stopEpicId: string;             // 要停止的 Epic ID
  startEpicId: string;            // 要启动的新 Epic ID
  reason?: string;                // 抢占原因
}

/**
 * Agent Query Payload
 */
export interface AgentQueryPayload {
  question: string;               // 问题内容
  replyToSessionId?: string;      // 回复到哪个 session
  timeoutMs?: number;             // 超时时间
}

/**
 * 生成 Operation ID
 */
export function generateOpId(): string {
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 创建 Operation
 */
export function createOperation(
  type: OpType,
  sourceAgentId: string,
  targetAgentId: string,
  options?: {
    projectPath?: string;
    epicId?: string;
    taskId?: string;
    payload?: Record<string, unknown>;
  }
): Operation {
  return {
    opId: generateOpId(),
    type,
    sourceAgentId,
    targetAgentId,
    projectPath: options?.projectPath,
    epicId: options?.epicId,
    taskId: options?.taskId,
    payload: options?.payload,
    createdAt: Date.now(),
    status: 'pending',
  };
}

/**
 * Operation 日志文件路径
 */
export const OPERATION_LOG_PATH = '~/.finger/runtime/operation-log.jsonl';

/**
 * 解析 Operation 日志路径（转换为绝对路径）
 */
export function resolveOperationLogPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return OPERATION_LOG_PATH.replace('~', home);
}

/**
 * 验证 Operation 类型
 */
export function isValidOpType(type: string): type is OpType {
  return Object.values(OpType).includes(type as OpType);
}

/**
 * 检查 Operation 是否已完成
 */
export function isOperationCompleted(op: Operation): boolean {
  return op.status === 'completed' || op.status === 'failed';
}

/**
 * 检查 Operation 是否需要持久化
 */
export function shouldPersistOperation(op: Operation): boolean {
  // 状态查询类不需要持久化
  const nonPersistTypes = [OpType.AGENT_STATUS, OpType.PROJECT_LIST, OpType.TEAM_STATUS];
  return !nonPersistTypes.includes(op.type);
}
