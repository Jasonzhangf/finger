/**
 * Heartbeat Mailbox Ping - 底层连通性测试
 * 
 * 类似 TCP keepalive，系统内部自动响应
 * 不需要 dispatch 给 agent，不需要模型推理
 * 
 * 设计原则：
 * 1. 链路层 Ping (Dry-Run) - 每轮心跳，agent 无感知
 * 2. E2E 测试 - 定期（每周），真实业务验证
 */

import { heartbeatMailbox } from './heartbeat-mailbox.js';
import { logger } from '../../core/logger.js';

const log = logger.module('HeartbeatMailboxPing');

/**
 * Mailbox Ping 结果
 */
export interface MailboxPingResult {
  /** agentId */
  agentId: string;
  /** 是否成功 */
  ok: boolean;
  /** 延迟 */
  latencyMs: number;
  /** 未读消息数 */
  unread: number;
  /** 待处理消息数 */
  pending: number;
  /** 处理中消息数（从 scheduler 内部跟踪） */
  processing: number;
  /** 时间戳 */
  timestamp: number;
  /** 错误信息 */
  error?: string;
}

/**
 * Mailbox Ping - 底层连通性测试
 * 
 * 直接读取 mailbox 状态，不 dispatch 给 agent
 * 类似 TCP keepalive，系统内部完成
 * 
 * @param agentId - 目标 agent ID
 * @returns Ping 结果
 */
export function mailboxPing(agentId: string): MailboxPingResult {
  const timestamp = Date.now();
  const startTime = timestamp;
  
  try {
    // 直接读取 mailbox 状态（底层操作）
    const allPending = heartbeatMailbox.listPending(agentId) ?? [];
    const unread = allPending.filter(m => !m.readAt).length;
    const pending = allPending.length;
    
    // processing 由 scheduler 内部跟踪，这里默认 0
    const processing = 0;
    
    const latencyMs = Date.now() - startTime;
    
    const result: MailboxPingResult = {
      agentId,
      ok: true,
      latencyMs,
      unread,
      pending,
      processing,
      timestamp,
    };
    
    // Debug 级别日志，避免高频 ping 打爆日志
    log.debug('[MailboxPing] Ping result', {
      agentId,
      latency: latencyMs,
      unread,
      pending,
    });
    
    return result;
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    log.error('[MailboxPing] Ping failed', error instanceof Error ? error : undefined, {
      agentId,
      error: errorMessage,
    });
    
    return {
      agentId,
      ok: false,
      latencyMs,
      unread: 0,
      pending: 0,
      processing: 0,
      timestamp,
      error: errorMessage,
    };
  }
}

/**
 * 批量 Ping 多个 agent
 * 
 * @param agentIds - 目标 agent ID 列表
 * @returns Ping 结果列表
 */
export function mailboxPingBatch(agentIds: string[]): MailboxPingResult[] {
  return agentIds.map(agentId => mailboxPing(agentId));
}

/**
 * 判断是否需要 E2E 测试
 * 
 * @param lastE2ETestAt - 上次 E2E 测试时间戳
 * @param e2eIntervalMs - E2E 测试间隔（默认 7 天）
 * @returns 是否需要 E2E 测试
 */
export function shouldRunE2ETest(
  lastE2ETestAt: number | undefined,
  e2eIntervalMs: number = 7 * 24 * 60 * 60 * 1000, // 默认 7 天
): boolean {
  if (!lastE2ETestAt) return true; // 从未测试过
  const now = Date.now();
  return now - lastE2ETestAt >= e2eIntervalMs;
}

/**
 * 默认 E2E 测试间隔（7 天）
 */
export const DEFAULT_E2E_TEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
