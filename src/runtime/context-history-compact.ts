import type { SessionMessage } from '../orchestration/session-types.js';
import {
  appendLedgerEvent,
  normalizeRootDir,
  resolveBaseDir,
  resolveCompactMemoryPath,
} from './context-ledger-memory-helpers.js';
import { estimateTokens } from '../utils/token-counter.js';
import { logger } from '../core/logger.js';
import { promises as fs } from 'fs';

const log = logger.module('context-history-compact');
const MAX_CONTENT_SUMMARY_LENGTH = 500;

export interface DigestMessage {
  id: string;
  timestamp: string;
  role: 'user' | 'assistant' | 'system';
  content_summary: string;
  tool_calls?: string[];
  key_entities?: string[];
  token_count: number;
}

export interface TurnDigestBlock {
  id: string;
  timestamp_ms: number;
  timestamp_iso: string;
  session_id: string;
  agent_id: string;
  mode: string;
  event_type: 'digest_block';
  payload: {
    messages: DigestMessage[];
    tags: string[];
    total_tokens: number;
    turn_digest: true;
  };
}

export interface AppendDigestForTurnOptions {
  tags: string[];
  currentMessage: SessionMessage;
  agentId: string;
  mode?: string;
}

function toDigestMessage(msg: SessionMessage): DigestMessage {
  const contentSummary = msg.content.length > MAX_CONTENT_SUMMARY_LENGTH
    ? `${msg.content.slice(0, MAX_CONTENT_SUMMARY_LENGTH)}...`
    : msg.content;

  const toolCalls: string[] = [];
  if (msg.toolName) {
    toolCalls.push(msg.toolName);
  }
  if (msg.metadata?.tool_calls && Array.isArray(msg.metadata.tool_calls)) {
    for (const tc of msg.metadata.tool_calls as unknown[]) {
      if (tc && typeof tc === 'object' && 'name' in tc) {
        const name = (tc as { name?: unknown }).name;
        if (typeof name === 'string' && name.trim().length > 0) {
          toolCalls.push(name);
        }
      }
    }
  }

  const keyEntities: string[] = [];
  const entityPatterns = [
    /\/[\w\-./]+/g,
    /https?:\/\/[^\s]+/g,
    /~\/[\w\-./]+/g,
  ];
  for (const pattern of entityPatterns) {
    const matches = contentSummary.match(pattern);
    if (matches) keyEntities.push(...matches.slice(0, 5));
  }

  return {
    id: msg.id,
    timestamp: msg.timestamp,
    role: msg.role,
    content_summary: contentSummary,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(keyEntities.length > 0 ? { key_entities: keyEntities } : {}),
    token_count: estimateTokens(contentSummary),
  };
}

export async function appendDigestForTurn(
  sessionId: string,
  rootDir: string,
  options: AppendDigestForTurnOptions,
): Promise<void> {
  const normalizedRootDir = normalizeRootDir(rootDir);
  const agentId = options.agentId || 'finger-system-agent';
  const mode = options.mode || 'main';
  const digestMessage = toDigestMessage(options.currentMessage);
  const now = Date.now();

  const digestBlock: TurnDigestBlock = {
    id: `digest-${now}-${Math.floor(Math.random() * 1_000_000)}`,
    timestamp_ms: now,
    timestamp_iso: new Date(now).toISOString(),
    session_id: sessionId,
    agent_id: agentId,
    mode,
    event_type: 'digest_block',
    payload: {
      messages: [digestMessage],
      tags: options.tags,
      total_tokens: digestMessage.token_count,
      turn_digest: true,
    },
  };

  const compactPath = resolveCompactMemoryPath(normalizedRootDir, sessionId, agentId, mode);
  const baseDir = resolveBaseDir(normalizedRootDir, sessionId, agentId, mode);
  await fs.mkdir(baseDir, { recursive: true });

  await appendLedgerEvent(compactPath, {
    session_id: sessionId,
    agent_id: agentId,
    mode,
    event_type: 'digest_block',
    payload: digestBlock.payload as Record<string, unknown>,
  });

  log.info('[appendDigestForTurn] Turn digest appended', {
    sessionId,
    agentId,
    digestId: digestBlock.id,
    tags: options.tags,
    tokenCount: digestMessage.token_count,
  });
}
