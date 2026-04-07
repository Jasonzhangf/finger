/**
 * Heartbeat Scheduler Helpers
 *
 * Extracted from heartbeat-scheduler.ts to stay under 500-line limit.
 * Contains mailbox prompt formatting, mailbox check dispatch, and project resolution utilities.
 * 
 * 设计原则（2026-04-07 更新）：
 * 1. 链路层 Ping (Dry-Run) - 每轮心跳，agent 无感知，底层自动完成
 * 2. 真实 Mailbox Check - 有待处理任务 + agent 空闲时，dispatch 给 agent
 * 3. E2E 测试 - 定期（每周），真实业务验证
 */

import { isObjectRecord } from '../common/object.js';

import { heartbeatMailbox } from './heartbeat-mailbox.js';
import { listAgents } from '../../agents/finger-system-agent/registry.js';
import { buildHeartbeatEnvelope, formatEnvelopesForContext, type MailboxEnvelope } from './mailbox-envelope.js';
import { logger } from '../../core/logger.js';
import type { ProgressDeliveryPolicy } from '../../common/progress-delivery-policy.js';
import { normalizeProgressDeliveryPolicy } from '../../common/progress-delivery-policy.js';
import { mailboxPing, mailboxPingBatch, type MailboxPingResult, shouldRunE2ETest, DEFAULT_E2E_TEST_INTERVAL_MS } from './heartbeat-mailbox-ping.js';

const log = logger.module('HeartbeatHelpers');

const SYSTEM_AGENT_ID = 'finger-system-agent';

/**
 * Build mailbox check targets from project agents list.
 */
export function buildMailboxCheckTargets(
  projectAgents: Awaited<ReturnType<typeof listAgents>>,
): Array<{ agentId: string; projectId?: string; status: string }> {
  const seen = new Set<string>();
  const targets: Array<{ agentId: string; projectId?: string; status: string }> = [];
  for (const agent of projectAgents) {
    if (!agent.agentId || seen.has(agent.agentId)) continue;
    seen.add(agent.agentId);
    targets.push({
      agentId: agent.agentId,
      projectId: agent.projectId,
      status: agent.status,
    });
  }
  if (!seen.has(SYSTEM_AGENT_ID)) {
    targets.push({ agentId: SYSTEM_AGENT_ID, status: 'idle' });
  }
  return targets;
}

/**
 * Clean up dispatch-result notifications from agent mailbox.
 */
export function cleanupDispatchResultNotifications(
  agentId: string,
): { matched: number; removed: number } {
  const notifications = heartbeatMailbox.list(agentId, {
    status: 'pending',
    category: 'notification',
  });
  if (notifications.length === 0) return { matched: 0, removed: 0 };

  const targets = notifications.filter((message) => {
    const content = isObjectRecord(message.content) ? message.content : null;
    return content?.type === 'dispatch-result';
  });
  if (targets.length === 0) return { matched: notifications.length, removed: 0 };

  let removed = 0;
  for (const message of targets) {
    const result = heartbeatMailbox.remove(agentId, message.id);
    if (result.removed) removed += 1;
  }
  return { matched: notifications.length, removed };
}

/**
 * Format a legacy mailbox check prompt from pending messages.
 */
export function formatLegacyMailboxPrompt(
  pending: ReturnType<typeof heartbeatMailbox.listPending>,
): string {
  const lines = ['# Mailbox Check', '你有待处理的系统任务，请逐条执行。', '', '待办任务列表：'];
  for (const msg of pending) {
    const msgContent = typeof msg.content === 'object' && msg.content
      ? msg.content as Record<string, unknown> : {};
    const taskId = typeof msgContent.taskId === 'string' ? msgContent.taskId : 'unknown';
    const projectId = typeof msgContent.projectId === 'string' ? msgContent.projectId : 'unknown';
    lines.push(`- messageId=${msg.id} taskId=${taskId} projectId=${projectId}`);
  }
  return lines.join('\n');
}

/**
 * Resolve a project ID to its filesystem path via agent registry.
 */
export async function resolveProjectPath(projectId: string | undefined): Promise<string | undefined> {
  if (!projectId) return undefined;
  const agents = await listAgents();
  const agent = agents.find(a => a.projectId === projectId);
  return agent?.projectPath;
}

export interface MailboxCheckTarget {
  agentId: string;
  projectId?: string;
  status: string;
}

export interface MailboxCheckContext {
  lastMailboxPromptAt: Map<string, number>;
  mailboxPromptDeferredByAgent: Set<string>;
  resolveMailboxCheckIntervalMs: (projectId?: string) => number;
  dispatchDirect: (
    targetAgentId: string,
    taskId: string,
    projectId: string | undefined,
    prompt: string,
    options?: { progressDelivery?: ProgressDeliveryPolicy },
  ) => Promise<boolean>;
}

/**
 * 链路层 Ping (Dry-Run) - 底层连通性测试
 * 
 * 类似 TCP keepalive，系统内部自动响应
 * 不需要 dispatch 给 agent，不需要模型推理
 * 
 * @param targets - 目标 agent 列表
 * @returns Ping 结果列表
 */
export function performMailboxPingDryRun(
  targets: MailboxCheckTarget[],
): MailboxPingResult[] {
  const results: MailboxPingResult[] = [];
  for (const target of targets) {
    const result = mailboxPing(target.agentId);
    results.push(result);
  }
  return results;
}

/**
 * 真实 Mailbox Check - 有待处理任务时 dispatch 给 agent
 * 
 * 条件：
 * 1. agent 有 pending 消息
 * 2. 到了检查时间（mailboxCheckIntervalMs）
 * 3. agent 不在 busy 状态（或 busy 但标记为 deferred）
 * 
 * @param ctx - Mailbox check 上下文
 */
export async function promptMailboxChecks(
  ctx: MailboxCheckContext,
): Promise<void> {
  const projectAgents = await listAgents();
  const agents = buildMailboxCheckTargets(projectAgents);
  
  // 先执行链路层 Ping（agent 无感知）
  const pingResults = performMailboxPingDryRun(agents);
  
  // Debug 日志记录 ping 结果
  for (const pingResult of pingResults) {
    if (pingResult.pending > 0 || !pingResult.ok) {
      log.debug('[HeartbeatScheduler] Mailbox ping result', {
        agentId: pingResult.agentId,
        ok: pingResult.ok,
        pending: pingResult.pending,
        unread: pingResult.unread,
        latency: pingResult.latencyMs,
      });
    }
  }
  
  // 然后检查是否需要 dispatch 真实的 mailbox-check 任务
  for (const agent of agents) {
    const now = Date.now();
    const mailboxCheckIntervalMs = ctx.resolveMailboxCheckIntervalMs(agent.projectId);
    const lastPrompt = ctx.lastMailboxPromptAt.get(agent.agentId) ?? 0;
    const due = now - lastPrompt >= mailboxCheckIntervalMs;

    const pendingAll = heartbeatMailbox.listPending(agent.agentId) ?? [];

    if (agent.status === 'busy' && due && pendingAll.length > 0) {
      // Registry-level busy can be stale. Mark deferred, but still allow
      // dispatchDirect to decide via runtime_view / queue behavior.
      ctx.mailboxPromptDeferredByAgent.add(agent.agentId);
      log.debug('[HeartbeatScheduler] Agent marked busy by registry; allow mailbox-check dispatch decision', {
        agentId: agent.agentId,
        status: agent.status,
      });
    }

    const notificationCleanup = cleanupDispatchResultNotifications(agent.agentId);
    if (notificationCleanup.removed > 0) {
      log.debug('[HeartbeatScheduler] Cleaned dispatch-result notifications', {
        agentId: agent.agentId,
        matched: notificationCleanup.matched,
        removed: notificationCleanup.removed,
      });
    }

    const pendingSnapshot = notificationCleanup.removed > 0
      ? (heartbeatMailbox.listPending(agent.agentId) ?? [])
      : pendingAll;

    if (pendingSnapshot.length === 0) {
      ctx.mailboxPromptDeferredByAgent.delete(agent.agentId);
      continue;
    }

    // Keep notifications actionable at idle time (news/email/channel notices),
    // only auto-clean dispatch-result notifications above.
    const pending = pendingSnapshot;
    const deferredNotificationCount = 0;

    const progressPolicies = pending
      .map((msg) => {
        const msgContent = typeof msg.content === 'object' && msg.content ? msg.content as Record<string, unknown> : {};
        return normalizeProgressDeliveryPolicy(msgContent.progressDelivery ?? msgContent.progress_delivery);
      })
      .filter((item): item is ProgressDeliveryPolicy => !!item);
    let progressDelivery: ProgressDeliveryPolicy | undefined;
    if (progressPolicies.length > 0) {
      const keys = Array.from(new Set(progressPolicies.map((item) => JSON.stringify(item))));
      if (keys.length === 1) {
        progressDelivery = progressPolicies[0];
      } else {
        log.warn('[HeartbeatScheduler] mailbox pending messages have mixed progressDelivery policies; skip session override', {
          agentId: agent.agentId,
          policyCount: keys.length,
        });
      }
    }

    const deferred = ctx.mailboxPromptDeferredByAgent.has(agent.agentId);
    if (!deferred && !due) continue;

    const envelopes: MailboxEnvelope[] = [];
    const messageRefs: string[] = [];
    for (const msg of pending) {
      const msgContent = typeof msg.content === 'object' && msg.content ? msg.content as Record<string, unknown> : {};
      const storedEnvelope = typeof msgContent.envelope === 'object' && msgContent.envelope
        ? msgContent.envelope as MailboxEnvelope
        : undefined;
      if (storedEnvelope) {
        envelopes.push(storedEnvelope);
      } else if (msgContent.envelopeId) {
        const prompt = typeof msgContent.prompt === 'string' ? msgContent.prompt : '';
        const projId = typeof msgContent.projectId === 'string' ? msgContent.projectId : undefined;
        if (prompt) envelopes.push(buildHeartbeatEnvelope(prompt, projId));
      }
      const refParts = [
        `messageId=${msg.id}`,
        typeof msgContent.dispatchId === 'string' ? `dispatchId=${msgContent.dispatchId}` : null,
        typeof msgContent.taskId === 'string' ? `taskId=${msgContent.taskId}` : null,
      ].filter((part): part is string => typeof part === 'string');
      messageRefs.push(`- ${refParts.join(' ')}`);
    }

    const mailboxContext = envelopes.length > 0
      ? formatEnvelopesForContext(envelopes)
      : messageRefs.map((r) => `- ${r}`).join('\n');

    const prompt = [
      '# Mailbox Check',
      '你有待处理的系统任务，请逐条执行。',
      '',
      '待办任务列表：',
      mailboxContext,
      '',
      '处理规则：',
      '1. 每次只处理一条任务，完成后再处理下一条。',
      '2. 调用 mailbox.read(messageId) 读取详情，执行任务，然后调用 mailbox.ack(messageId) 标记完成。',
      '3. 如果暂时无法处理，不要 ack；未读取的保持 pending，已读取的保持 processing。',
      '',
      '每个任务完成后必须调用 report-task-completion 工具提交 summary。',
      '如果提交失败必须重试直到成功，避免断链。',
    ].join('\n');
    const dispatched = await ctx.dispatchDirect(
      agent.agentId,
      'mailbox-check',
      agent.projectId,
      prompt,
      progressDelivery ? { progressDelivery } : undefined,
    );
    if (dispatched) {
      ctx.lastMailboxPromptAt.set(agent.agentId, now);
      ctx.mailboxPromptDeferredByAgent.delete(agent.agentId);
    } else {
      ctx.mailboxPromptDeferredByAgent.add(agent.agentId);
    }
  }
}

/**
 * Format mailbox check prompt (exported for scheduler compatibility).
 */
export function formatMailboxCheckPrompt(envelopes: MailboxEnvelope[], messageRefs: string[]): string {
  const mailboxContext = envelopes.length > 0
    ? formatEnvelopesForContext(envelopes)
    : messageRefs.map((r) => `- ${r}`).join('\n');
  return mailboxContext;
}

// Re-export mailbox ping utilities
export { mailboxPing, mailboxPingBatch, shouldRunE2ETest, DEFAULT_E2E_TEST_INTERVAL_MS };
export type { MailboxPingResult };
