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

const TEXT_KEYS = ['text', 'message', 'prompt', 'content'];

export function parseUnifiedAgentInput(message: unknown): UnifiedAgentInput | null {
  if (typeof message === 'string') {
    const text = message.trim();
    if (text.length === 0) return null;
    return { text };
  }

  if (!isRecord(message)) return null;
  const text = extractText(message);
  if (!text) return null;

  const input: UnifiedAgentInput = {
    text,
    sessionId: asOptionalString(message.sessionId),
    createNewSession: typeof message.createNewSession === 'boolean' ? message.createNewSession : undefined,
    sender: parseSender(message.sender),
    history: parseHistory(message.history),
    metadata: isRecord(message.metadata) ? message.metadata : undefined,
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
  if (inputHistory && inputHistory.length > 0) {
    const normalized = inputHistory.map((item, index) => ({
      id: `ext-${Date.now()}-${index}`,
      role: item.role,
      content: item.content,
      timestamp: new Date().toISOString(),
    }));
    return normalized.slice(-Math.max(1, limit));
  }

  return sessionHistory.slice(-Math.max(1, limit));
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
