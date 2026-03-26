import type { SessionMessage } from '../chat/session-types.js';

export interface UnifiedAgentSender {
  id?: string;
  name?: string;
  role?: string;
}

export interface UnifiedHistoryItem {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface UnifiedAgentRoleProfile {
  id: string;
  systemPrompt?: string;
  systemPromptResolver?: () => string | undefined;
  allowedTools?: string[];
}

export interface UnifiedAgentInput {
  text: string;
  sessionId?: string;
  createNewSession?: boolean;
  sender?: UnifiedAgentSender;
  history?: UnifiedHistoryItem[];
  metadata?: Record<string, unknown>;
  roleProfile?: string;
  tools?: string[];
}

export interface UnifiedAgentOutput {
  success: boolean;
  response?: string;
  error?: string;
  module: string;
  provider: string;
  sessionId: string;
  messageId?: string;
  latencyMs: number;
  metadata?: {
    roleProfile?: string;
    tools?: string[];
    [key: string]: unknown;
  };
}

const TEXT_KEYS = ['text', 'message', 'prompt', 'content', 'task', 'description'];

export function parseUnifiedAgentInput(message: unknown): UnifiedAgentInput | null {
  if (typeof message === 'string') {
    const text = message.trim();
    if (text.length === 0) return null;
    return { text };
  }

  if (!isRecord(message)) return null;
  const text = extractText(message);
  if (!text) return null;

  const meta = isRecord(message.metadata) ? message.metadata : undefined;
  const topSessionId = asOptionalString(message.sessionId);
  const metaSessionId = meta ? asOptionalString(meta.sessionId) ?? asOptionalString((meta as Record<string, unknown>).session_id) : undefined;
  if (topSessionId && metaSessionId && topSessionId !== metaSessionId) {
    throw new Error(`Conflicting sessionId sources: sessionId=${topSessionId}, metadata.sessionId=${metaSessionId}`);
  }
  const resolvedSessionId = topSessionId ?? metaSessionId;

  const input: UnifiedAgentInput = {
    text,
    sessionId: resolvedSessionId,
    createNewSession: typeof message.createNewSession === 'boolean' ? message.createNewSession : undefined,
    sender: parseSender(message.sender),
    history: parseHistory(message.history),
    metadata: meta,
    roleProfile: asOptionalString(message.roleProfile),
    tools: parseStringArray(message.tools),
  };

  return input;
}

export function mergeHistory(
  sessionHistory: SessionMessage[],
  inputHistory: UnifiedHistoryItem[] | undefined,
  limit: number,
): SessionMessage[] {
  const unlimited = !Number.isFinite(limit) || limit <= 0;
  const safeLimit = Math.max(1, Math.floor(limit));
  // Session 历史是唯一真源，优先使用 session 存储中的历史
  // 前端传来的 inputHistory 仅在 session 为空时作为补充（首次会话场景）
  if (sessionHistory && sessionHistory.length > 0) {
    return unlimited ? [...sessionHistory] : sessionHistory.slice(-safeLimit);
  }

  // 只有当 session 历史为空时，才使用前端传来的历史（首次会话）
  if (inputHistory && inputHistory.length > 0) {
    const normalized = inputHistory.map((item, index) => ({
      id: `ext-${Date.now()}-${index}`,
      role: item.role,
      content: item.content,
      timestamp: new Date().toISOString(),
    }));
    return unlimited ? normalized : normalized.slice(-safeLimit);
  }

  return [];
}

function extractText(record: Record<string, unknown>): string | null {
  for (const key of TEXT_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function parseSender(value: unknown): UnifiedAgentSender | undefined {
  if (!isRecord(value)) return undefined;

  return {
    id: asOptionalString(value.id),
    name: asOptionalString(value.name),
    role: asOptionalString(value.role),
  };
}

function parseHistory(value: unknown): UnifiedHistoryItem[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const result: UnifiedHistoryItem[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const role = item.role;
    const content = item.content;
    if ((role === 'user' || role === 'assistant' || role === 'system') && typeof content === 'string') {
      result.push({ role, content });
    }
  }

  return result.length > 0 ? result : undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return result.length > 0 ? Array.from(new Set(result)) : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
