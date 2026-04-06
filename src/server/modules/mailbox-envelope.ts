/**
 * Mailbox Envelope Builder
 */

export type MailboxCategory = 'System' | 'User' | 'Notification';

export interface MailboxEnvelope {
  id: string;
  category: MailboxCategory;
  title: string;
  shortDescription: string;
  fullText: string;
  expectedReply?: {
    format: string;
    description: string;
    optional: boolean;
  };
  metadata: {
    createdAt: string;
    source: string;
    priority: 'high' | 'medium' | 'low';
    expiresAt?: string;
    relatedSessionId?: string;
    relatedTaskId?: string;
  };
}

export interface BuildEnvelopeOptions {
  category: MailboxCategory;
  title: string;
  shortDescription: string;
  fullText: string;
  source: string;
  priority?: 'high' | 'medium' | 'low';
  expectedReply?: MailboxEnvelope['expectedReply'];
  relatedSessionId?: string;
  relatedTaskId?: string;
  ttlMs?: number;
}

function generateEnvelopeId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `mail-${timestamp}-${random}`;
}

export function buildMailboxEnvelope(options: BuildEnvelopeOptions): MailboxEnvelope {
  const {
    category,
    title,
    shortDescription,
    fullText,
    source,
    priority = 'medium',
    expectedReply,
    relatedSessionId,
    relatedTaskId,
    ttlMs,
  } = options;

  const now = new Date().toISOString();
  const expiresAt = ttlMs ? new Date(Date.now() + ttlMs).toISOString() : undefined;

  return {
    id: generateEnvelopeId(),
    category,
    title,
    shortDescription,
    fullText,
    expectedReply,
    metadata: {
      createdAt: now,
      source,
      priority,
      expiresAt,
      relatedSessionId,
      relatedTaskId,
    },
  };
}

export function formatEnvelopeForContext(
  envelope: MailboxEnvelope,
  includeFull = false,
): string {
  const priorityEmoji = { high: '🔴', medium: '🟡', low: '🟢' } as const;
  const categoryPrefix = `[${envelope.category}]`;
  const priorityIcon = priorityEmoji[envelope.metadata.priority];

  let text = `${priorityIcon} ${categoryPrefix} ${envelope.title}\n`;
  text += `> ${envelope.shortDescription}\n`;

  if (includeFull && envelope.fullText) {
    text += `\n---\n${envelope.fullText}\n`;
  }

  if (envelope.expectedReply) {
    text += `\n📤 期望回复: ${envelope.expectedReply.description}`;
    if (envelope.expectedReply.optional) {
      text += ' (可选)';
    }
    text += '\n';
  }

  return text;
}

export function formatEnvelopesForContext(
  envelopes: MailboxEnvelope[],
  tokenBudget = 2000,
  avgTokensPerLine = 10,
): string {
  if (envelopes.length === 0) {
    return '# Mailbox\n\n当前没有未读消息。\n';
  }

  const sorted = [...envelopes].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 } as const;
    return order[a.metadata.priority] - order[b.metadata.priority];
  });

  let output = '# Mailbox\n\n';
  let usedTokens = 20;

  for (const envelope of sorted) {
    const shortVersion = formatEnvelopeForContext(envelope, false);
    const shortTokens = shortVersion.split('\n').length * avgTokensPerLine;

    const fullVersion = formatEnvelopeForContext(envelope, true);
    const fullTokens = fullVersion.split('\n').length * avgTokensPerLine;

    if (usedTokens + fullTokens <= tokenBudget) {
      output += `${fullVersion}\n---\n\n`;
      usedTokens += fullTokens;
      continue;
    }
    if (usedTokens + shortTokens <= tokenBudget) {
      output += `${shortVersion}\n---\n\n`;
      usedTokens += shortTokens;
      continue;
    }

    const icon = envelope.category === 'System' ? '🔴' : envelope.category === 'User' ? '🔵' : '🟢';
    output += `${icon} [${envelope.category}] ${envelope.title}\n---\n\n`;
    usedTokens += 30;
  }

  return output;
}

export function buildHeartbeatEnvelope(
  heartbeatContent: string,
  projectId?: string,
): MailboxEnvelope {
  return buildMailboxEnvelope({
    category: 'System',
    title: 'Heartbeat Task',
    shortDescription: '定时系统巡检任务，需要检查并处理。',
    fullText: heartbeatContent,
    source: 'heartbeat',
    priority: 'low',
    expectedReply: {
      format: 'text',
      description: '完成任务后简短汇报结果，或说明跳过原因',
      optional: true,
    },
    relatedTaskId: projectId,
  });
}

export function buildDispatchResultEnvelope(
  childSessionId: string,
  summary: string,
  error?: string,
  projectId?: string,
  tags?: string[],
  topic?: string,
): MailboxEnvelope {
  const isError = Boolean(error);
  const tagLine = tags && tags.length > 0
    ? `\n\n**Tags**: ${tags.join(', ')}`
    : '';
  const topicLine = topic ? `\n\n**Topic**: ${topic}` : '';
  return buildMailboxEnvelope({
    category: 'System',
    title: isError ? 'Dispatch 任务失败' : 'Dispatch 任务完成',
    shortDescription: isError
      ? `子任务执行失败: ${error}`
      : `子任务已完成，摘要: ${summary.substring(0, 100)}${summary.length > 100 ? '...' : ''}${topic ? ` [${topic}]` : ''}`,
    fullText: isError
      ? `## Dispatch 任务失败\n\n**子会话ID**: ${childSessionId}\n\n**错误信息**: ${error}\n\n请检查错误并决定是否重试。${tagLine}${topicLine}`
      : `## Dispatch 任务完成\n\n**子会话ID**: ${childSessionId}\n\n**执行摘要**:\n${summary}${tagLine}${topicLine}`,
    source: 'dispatch',
    priority: isError ? 'high' : 'medium',
    expectedReply: {
      format: 'text',
      description: isError ? '请决定是否重试或采取其他行动' : '确认收到结果，或继续后续任务',
      optional: !isError,
    },
    relatedSessionId: childSessionId,
    relatedTaskId: projectId,
  });
}

export function buildQueuedDispatchEnvelope(params: {
  dispatchId: string;
  sourceAgentId: string;
  targetAgentId: string;
  sessionId?: string;
  workflowId?: string;
  taskText: string;
  assignment?: {
    taskId?: string;
    bdTaskId?: string;
    epicId?: string;
  };
}): MailboxEnvelope {
  const assignmentLines = [
    typeof params.assignment?.taskId === 'string' && params.assignment.taskId.trim().length > 0
      ? `- taskId: ${params.assignment.taskId.trim()}`
      : null,
    typeof params.assignment?.bdTaskId === 'string' && params.assignment.bdTaskId.trim().length > 0
      ? `- bdTaskId: ${params.assignment.bdTaskId.trim()}`
      : null,
    typeof params.assignment?.epicId === 'string' && params.assignment.epicId.trim().length > 0
      ? `- epicId: ${params.assignment.epicId.trim()}`
      : null,
  ].filter((line): line is string => typeof line === 'string');

  return buildMailboxEnvelope({
    category: 'User',
    title: 'Queued Dispatch Task',
    shortDescription: `队列超时后转入邮箱，等待 ${params.targetAgentId} 空闲后处理。`,
    fullText: [
      '# Queued Dispatch Task',
      '',
      `dispatchId: ${params.dispatchId}`,
      `sourceAgentId: ${params.sourceAgentId}`,
      `targetAgentId: ${params.targetAgentId}`,
      ...(typeof params.sessionId === 'string' && params.sessionId.trim().length > 0 ? [`sessionId: ${params.sessionId.trim()}`] : []),
      ...(typeof params.workflowId === 'string' && params.workflowId.trim().length > 0 ? [`workflowId: ${params.workflowId.trim()}`] : []),
      ...(assignmentLines.length > 0 ? ['', 'assignment:', ...assignmentLines] : []),
      '',
      'task:',
      params.taskText,
      '',
      '处理要求：单条任务可先用 mailbox.read(id) 读取并领取；若同类任务很多，可先用 mailbox.read_all(...) 批量标记已读/领取。完成后用 mailbox.ack(id, { summary/result }) 或 mailbox.ack(id, { status: "failed", error }) 回写终态（ack 后消息会自动清理）；若尚未处理，不要 ack。notification 等非任务消息可按需 mailbox.remove(id) / mailbox.remove_all(...) 清理。',
    ].join('\n'),
    source: 'dispatch-timeout',
    priority: 'high',
    expectedReply: {
      format: 'mailbox.ack',
      description: '处理完成或失败后调用 mailbox.ack(...) 回写终态（会自动清理）；notification 清理可用 mailbox.remove(...) / mailbox.remove_all(...)',
      optional: false,
    },
    relatedSessionId: params.sessionId,
    relatedTaskId: params.assignment?.taskId ?? params.assignment?.bdTaskId,
  });
}

export function buildUserNotificationEnvelope(
  title: string,
  message: string,
  priority: 'high' | 'medium' | 'low' = 'medium',
): MailboxEnvelope {
  return buildMailboxEnvelope({
    category: 'User',
    title,
    shortDescription: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
    fullText: message,
    source: 'user_notification',
    priority,
    expectedReply: {
      format: 'text',
      description: '确认收到通知',
      optional: true,
    },
  });
}

/**
 * 构建 Inject Prompt（心跳控制说明）
 * 仅在 RUNNING 或 DEGRADED 状态注入，PAUSED/STOPPED 不注入
 */
export function buildHeartbeatInjectPrompt(
  heartbeatState: 'RUNNING' | 'DEGRADED' | 'PAUSED' | 'STOPPED',
  mailboxHealth?: {
    pending: number;
    processing: number;
    oldestPendingAgeMs?: number;
  },
): string {
  // PAUSED/STOPPED 状态不注入控制说明
  if (heartbeatState === 'PAUSED' || heartbeatState === 'STOPPED') {
    return '';
  }

  const stateEmoji = heartbeatState === 'RUNNING' ? '✅' : '⚠️';
  const stateLabel = heartbeatState === 'RUNNING' ? '正常运行' : '降级运行';

  let inject = `
---
## 心跳控制说明

当前状态: ${stateEmoji} ${heartbeatState} (${stateLabel})
`;

  // 如果有 mailbox 健康 data，添加状态说明
  if (mailboxHealth) {
    inject += `Mailbox 健康: ${mailboxHealth.pending} pending / ${mailboxHealth.processing} processing
`;
    if (mailboxHealth.oldestPendingAgeMs && mailboxHealth.oldestPendingAgeMs > 300000) {
      inject += `⚠️ 最老 pending 消息已等待 ${Math.round(mailboxHealth.oldestPendingAgeMs / 60000)} 分钟
`;
    }
  }

  inject += `
### 你有以下控制能力（通过 Kernel Tools）

| 工具 | 用途 | 推荐触发条件 |
|------|------|--------------|
| heartbeat.stop | 停止心跳（PAUSED/STOPPED） | mailbox pending > 50 或持续错误 |
| heartbeat.resume | 恢复心跳（PAUSED → RUNNING） | 任务阻塞已清理，可恢复 |
| mailbox.health | 检查 mailbox 健康 | 每轮心跳开始时检查 |
| mailbox.clear | 清理 mailbox 消息 | 堆积消息需要清理 |
| mailbox.mark_skip | 标记重复消息为跳过 | 发现重复消息需要去重 |

### Agent 决策建议

- **发现堆积**: 先调用 mailbox.clear 清理 → 若清理成功继续，若失败调用 heartbeat.stop
- **发现重复**: 调用 mailbox.mark_skip(ids=[...], reason="重复通知无需处理")
- **任务阻塞**: 调用 heartbeat.stop(resume_after_minutes=60) → 60 分钟后自动恢复
- **恢复正常**: 调用 heartbeat.resume("任务阻塞已清理")

---
`;

  return inject;
}

/**
 * 构建心跳 Envelope（带 Inject Prompt）
 */
export function buildHeartbeatEnvelopeWithInject(
  heartbeatContent: string,
  heartbeatState: 'RUNNING' | 'DEGRADED' | 'PAUSED' | 'STOPPED',
  mailboxHealth?: {
    pending: number;
    processing: number;
    oldestPendingAgeMs?: number;
  },
  projectId?: string,
): MailboxEnvelope {
  const injectPrompt = buildHeartbeatInjectPrompt(heartbeatState, mailboxHealth);
  const fullText = injectPrompt + heartbeatContent;

  return buildMailboxEnvelope({
    category: 'System',
    title: 'Heartbeat Task',
    shortDescription: '定时系统巡检任务，需要检查并处理。',
    fullText,
    source: 'heartbeat',
    priority: 'low',
    expectedReply: {
      format: 'text',
      description: '完成任务后简短汇报结果，或说明跳过原因',
      optional: true,
    },
    relatedTaskId: projectId,
  });
}
