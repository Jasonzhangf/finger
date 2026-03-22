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
): MailboxEnvelope {
  const isError = Boolean(error);
  return buildMailboxEnvelope({
    category: 'System',
    title: isError ? 'Dispatch 任务失败' : 'Dispatch 任务完成',
    shortDescription: isError
      ? `子任务执行失败: ${error}`
      : `子任务已完成，摘要: ${summary.substring(0, 100)}${summary.length > 100 ? '...' : ''}`,
    fullText: isError
      ? `## Dispatch 任务失败\n\n**子会话ID**: ${childSessionId}\n\n**错误信息**: ${error}\n\n请检查错误并决定是否重试。`
      : `## Dispatch 任务完成\n\n**子会话ID**: ${childSessionId}\n\n**执行摘要**:\n${summary}`,
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
