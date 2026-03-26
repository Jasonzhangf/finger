interface TopicRule {
  topic: string;
  tags: string[];
  keywords: string[];
}

export interface InferTagTopicInput {
  texts: Array<string | undefined>;
  seedTags?: string[];
  seedTopic?: string;
  maxTags?: number;
}

export interface InferTagTopicOutput {
  tags?: string[];
  topic?: string;
}

const TOPIC_RULES: TopicRule[] = [
  {
    topic: 'context-builder',
    tags: ['context-builder', 'history-rebuild'],
    keywords: ['context builder', '上下文重组', '重组上下文', 'context monitor', 'history budget', 'working_set', 'historical_memory'],
  },
  {
    topic: 'ledger',
    tags: ['ledger', 'memory'],
    keywords: ['context_ledger', 'ledger', '记忆', 'memory', 'slot_start', 'slot_end', 'timeline'],
  },
  {
    topic: 'mailbox',
    tags: ['mailbox', 'notification'],
    keywords: ['mailbox', '收件箱', '通知', 'ack', 'read_all', 'remove_all'],
  },
  {
    topic: 'dispatch',
    tags: ['dispatch', 'agent-routing'],
    keywords: ['dispatch', '派发', 'agent.dispatch', 'project agent', 'system agent'],
  },
  {
    topic: 'multimodal',
    tags: ['multimodal', 'attachment'],
    keywords: ['image', 'local_image', 'pdf', '附件', '图片', '多模态', 'view_image'],
  },
  {
    topic: 'channel',
    tags: ['channel', 'bot'],
    keywords: ['qq', 'qqbot', 'weixin', 'wechat', 'channel', 'webui'],
  },
  {
    topic: 'flow',
    tags: ['flow', 'workflow'],
    keywords: ['flow.md', 'task flow', '流程', '状态机', 'state-machine'],
  },
  {
    topic: 'heartbeat',
    tags: ['heartbeat', 'scheduler'],
    keywords: ['heartbeat', '心跳', '定时', 'clock', 'schedule'],
  },
  {
    topic: 'skills',
    tags: ['skills'],
    keywords: ['skills', 'skill', '技能'],
  },
  {
    topic: 'email',
    tags: ['email', 'mail'],
    keywords: ['email', 'gmail', 'qq邮箱', '企业邮箱', '邮件'],
  },
];

function normalizeTag(raw: string): string | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length < 2) return undefined;
  if (trimmed.length > 48) return trimmed.slice(0, 48);
  return trimmed;
}

function extractHashTags(text: string): string[] {
  const result: string[] = [];
  const regex = /#([a-zA-Z0-9_.-]{2,32})/g;
  let match: RegExpExecArray | null = regex.exec(text);
  while (match) {
    const normalized = normalizeTag(match[1]);
    if (normalized) result.push(normalized);
    match = regex.exec(text);
  }
  return result;
}

function toLowerJoinedText(texts: Array<string | undefined>): string {
  return texts
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.toLowerCase())
    .join('\n');
}

function dedupeTags(tags: string[], maxTags: number): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of tags) {
    const normalized = normalizeTag(raw);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
    if (ordered.length >= maxTags) break;
  }
  return ordered;
}

export function inferTagsAndTopic(input: InferTagTopicInput): InferTagTopicOutput {
  const maxTags = Number.isFinite(input.maxTags) ? Math.max(1, Math.floor(input.maxTags as number)) : 8;
  const combined = toLowerJoinedText(input.texts);

  const inferredTags: string[] = [];
  if (Array.isArray(input.seedTags)) inferredTags.push(...input.seedTags);

  const inferredTopic = normalizeTag(input.seedTopic ?? '');
  let topic = inferredTopic;

  for (const text of input.texts) {
    if (!text) continue;
    inferredTags.push(...extractHashTags(text));
  }

  for (const rule of TOPIC_RULES) {
    const hit = rule.keywords.some((keyword) => combined.includes(keyword));
    if (!hit) continue;
    if (!topic) topic = rule.topic;
    inferredTags.push(...rule.tags);
  }

  const tags = dedupeTags(inferredTags, maxTags);
  return {
    ...(tags.length > 0 ? { tags } : {}),
    ...(topic ? { topic } : {}),
  };
}

