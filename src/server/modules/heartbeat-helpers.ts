/**
 * Heartbeat Scheduler Helpers
 *
 * Extracted from heartbeat-scheduler.ts to stay under 500-line limit.
 * Contains mailbox prompt formatting, auto-repair dispatch, and project resolution utilities.
 */

import { isObjectRecord } from '../common/object.js';

import { heartbeatMailbox } from './heartbeat-mailbox.js';
import { listAgents } from '../../agents/finger-system-agent/registry.js';
import { buildHeartbeatEnvelope, formatEnvelopesForContext, type MailboxEnvelope } from './mailbox-envelope.js';
import { logger } from '../../core/logger.js';

const log = logger.module('HeartbeatHelpers');


const SYSTEM_AGENT_ID = 'finger-system-agent';

/**
 * Build mailbox check targets from project agents list.
 * Ensures system agent is always included for dispatch-result notification handling.
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

  // System agent mailbox is also part of runtime dispatch lifecycle.
  // Must be checked periodically, otherwise dispatch-result notifications can accumulate.
  if (!seen.has(SYSTEM_AGENT_ID)) {
    targets.push({
      agentId: SYSTEM_AGENT_ID,
      status: 'idle',
    });
  }
  return targets;
}

/**
 * Clean up dispatch-result notifications from agent mailbox.
 * Returns count of matched and removed notifications.
 */
export function cleanupDispatchResultNotifications(
  agentId: string,
): { matched: number; removed: number } {
  const notifications = heartbeatMailbox.list(agentId, {
    status: 'pending',
    category: 'notification',
  });
  if (notifications.length === 0) {
    return { matched: 0, removed: 0 };
  }

  const targets = notifications.filter((message) => {
    const content = isObjectRecord(message.content) ? message.content : null;
    return content?.type === 'dispatch-result';
  });
  if (targets.length === 0) {
    return { matched: notifications.length, removed: 0 };
  }

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

/**
 * Dispatch an auto-repair task for HEARTBEAT.md format issues.
 */
export function dispatchAutoRepairTask(
  projectId: string | undefined,
  heartbeatMdPath: string,
  validation: { errors: string[]; warnings: string[] },
): void {
  const targetAgentId = 'finger-system-agent';
  const taskId = `heartbeat-repair:${projectId ?? 'global'}`;

  const promptLines = [
    '# HEARTBEAT.md Auto-Repair Request',
    'The HEARTBEAT.md format is invalid or missing. Please repair it to the routecodex format.',
    '',
    `File: ${heartbeatMdPath}`,
    projectId ? `Project ID: ${projectId}` : 'Project ID: global',
    '',
    'Validation errors:',
    ...validation.errors.map(err => `- ${err}`),
    '',
    'Warnings:',
    ...validation.warnings.map(warn => `- ${warn}`),
    '',
    'Required format: YAML front matter (---) with title, version, updated_at, and optional Heartbeat-Stop-When / Heartbeat-Until fields.',
    'Make sure to preserve existing checklist items if possible.',
  ];

  const mailboxPayload = {
    type: 'heartbeat-repair',
    taskId,
    projectId,
    prompt: promptLines.join('\n'),
    requiresFeedback: true,
  };

  heartbeatMailbox.append(targetAgentId, mailboxPayload, {
    sender: 'system-heartbeat',
    sourceType: 'control',
    category: 'heartbeat-repair',
    priority: 0,
  });
}
