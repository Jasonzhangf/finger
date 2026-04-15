import { join } from 'path';
import { getContextWindow, loadContextBuilderSettings } from '../../core/user-settings.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { forceRebuild, tokenizeUserInput } from '../../runtime/context-history/index.js';
import { hasSessionLock } from '../../runtime/context-history/lock.js';
import { normalizeRootDirForAgent, resolveLedgerPath } from '../../runtime/context-ledger-memory-helpers.js';
import type { SessionMessage } from '../../orchestration/session-types.js';
import type { InternalTool, ToolExecutionContext } from './types.js';
import { logger } from '../../core/logger.js';

const log = logger.module('ContextBuilderRebuild');
const REBUILD_RATE_LIMIT_MS = 5 * 60 * 1000;
const sessionRebuildTimestamps = new Map<string, number>();

interface ContextBuilderRebuildInput {
  session_id?: string;
  agent_id?: string;
  mode?: 'minimal' | 'moderate' | 'aggressive';
  target_budget?: number;
  rebuild_budget?: number;
  budget_tokens?: number;
  current_prompt?: string;
  include_messages?: boolean;
  message_limit?: number;
  _runtime_context?: Record<string, unknown>;
}

interface ContextBuilderRebuildOutput {
  ok: boolean;
  action: 'rebuild' | 'skipped';
  reason?: 'rate_limited' | 'rebuild_already_in_progress' | 'rebuild_failed';
  sessionId: string;
  agentId: string;
  targetBudget: number;
  metadata?: Record<string, unknown>;
  buildMode?: 'topic' | 'overflow';
  selectedBlockIds: string[];
  rateLimitSeconds?: number;
  appliesNextTurn?: boolean;
  messages?: Array<{
    id: string;
    role: string;
    tokenCount: number;
    contextZone?: 'working_set' | 'historical_memory';
    contentPreview: string;
  }>;
  __rebuiltMessages?: SessionMessage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}

function parseInput(rawInput: unknown): ContextBuilderRebuildInput {
  if (!isRecord(rawInput)) return {};
  return {
    session_id: typeof rawInput.session_id === 'string' ? rawInput.session_id : undefined,
    agent_id: typeof rawInput.agent_id === 'string' ? rawInput.agent_id : undefined,
    mode: rawInput.mode === 'minimal' || rawInput.mode === 'moderate' || rawInput.mode === 'aggressive'
      ? rawInput.mode
      : undefined,
    target_budget: typeof rawInput.target_budget === 'number' ? rawInput.target_budget : undefined,
    rebuild_budget: typeof rawInput.rebuild_budget === 'number' ? rawInput.rebuild_budget : undefined,
    budget_tokens: typeof rawInput.budget_tokens === 'number' ? rawInput.budget_tokens : undefined,
    current_prompt: typeof rawInput.current_prompt === 'string' ? rawInput.current_prompt : undefined,
    include_messages: rawInput.include_messages === true,
    message_limit: typeof rawInput.message_limit === 'number' ? rawInput.message_limit : undefined,
    _runtime_context: isRecord(rawInput._runtime_context) ? rawInput._runtime_context : undefined,
  };
}

function resolveRootDir(input: ContextBuilderRebuildInput, agentId: string, context: ToolExecutionContext): string {
  const runtimeRoot = input._runtime_context?.root_dir;
  if (typeof runtimeRoot === 'string' && runtimeRoot.trim().length > 0) return runtimeRoot;
  if (agentId === 'finger-system-agent') {
    return join(FINGER_PATHS.home, 'system', 'sessions');
  }
  if (context.cwd.startsWith(join(FINGER_PATHS.home, 'system'))) {
    return join(FINGER_PATHS.home, 'system', 'sessions');
  }
  return FINGER_PATHS.sessions.dir;
}

function parseRuntimeSessionMessages(runtimeContext: Record<string, unknown> | undefined): SessionMessage[] {
  const raw = runtimeContext?.session_messages;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item, index) => {
      const roleRaw = typeof item.role === 'string' ? item.role.trim() : '';
      const role: SessionMessage['role'] = roleRaw === 'assistant' || roleRaw === 'system' ? roleRaw : 'user';
      const timestamp = typeof item.timestamp === 'string' && item.timestamp.trim().length > 0
        ? item.timestamp
        : new Date(Date.now() + index).toISOString();
      const metadata = isRecord(item.metadata) ? item.metadata : undefined;
      const attachments = Array.isArray(item.attachments) ? item.attachments : undefined;
      return {
        id: typeof item.id === 'string' && item.id.trim().length > 0 ? item.id : 'runtime-' + String(index + 1),
        role,
        content: typeof item.content === 'string' ? item.content : '',
        timestamp,
        ...(metadata ? { metadata } : {}),
        ...(attachments ? { attachments } : {}),
      } satisfies SessionMessage;
    })
    .filter((item) => item.content.trim().length > 0);
}

function resolvePrompt(input: ContextBuilderRebuildInput, sessionMessages: SessionMessage[]): string {
  if (typeof input.current_prompt === 'string' && input.current_prompt.trim().length > 0) {
    return input.current_prompt.trim();
  }
  const latestUser = [...sessionMessages].reverse().find((message) => message.role === 'user');
  return latestUser?.content?.trim() ?? '';
}

export const contextBuilderRebuildTool: InternalTool<unknown, ContextBuilderRebuildOutput> = {
  name: 'context_builder.rebuild',
  executionModel: 'state',
  description: 'Rebuild dynamic history through the single runtime/context-history implementation. Explicit topic rebuild recalls digest history by keyword match and rewrites only P4 dynamic history.',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string' },
      agent_id: { type: 'string' },
      mode: { type: 'string', enum: ['minimal', 'moderate', 'aggressive'] },
      target_budget: { type: 'number' },
      rebuild_budget: { type: 'number' },
      budget_tokens: { type: 'number' },
      current_prompt: { type: 'string' },
      include_messages: { type: 'boolean' },
      message_limit: { type: 'number' },
      _runtime_context: { type: 'object' },
    },
    additionalProperties: true,
  },
  execute: async (rawInput: unknown, context: ToolExecutionContext): Promise<ContextBuilderRebuildOutput> => {
    const input = parseInput(rawInput);
    const sessionId = (input.session_id ?? context.sessionId ?? '').trim();
    if (sessionId.length === 0) {
      throw new Error('context_builder.rebuild requires session_id (or active tool context sessionId)');
    }

    const lastRebuildTime = sessionRebuildTimestamps.get(sessionId) || 0;
    const elapsedSinceLastRebuild = Date.now() - lastRebuildTime;
    if (elapsedSinceLastRebuild < REBUILD_RATE_LIMIT_MS) {
      return {
        ok: false,
        action: 'skipped',
        reason: 'rate_limited',
        sessionId,
        agentId: context.agentId ?? 'finger-system-agent',
        targetBudget: 0,
        selectedBlockIds: [],
        rateLimitSeconds: Math.floor((REBUILD_RATE_LIMIT_MS - elapsedSinceLastRebuild) / 1000),
      };
    }

    if (hasSessionLock(sessionId)) {
      return {
        ok: false,
        action: 'skipped',
        reason: 'rebuild_already_in_progress',
        sessionId,
        agentId: context.agentId ?? 'finger-system-agent',
        targetBudget: 0,
        selectedBlockIds: [],
      };
    }

    const agentId = (input.agent_id ?? context.agentId ?? 'finger-system-agent').trim();
    const settings = loadContextBuilderSettings();
    const contextWindow = getContextWindow();
    const requestedBudget = [input.rebuild_budget, input.budget_tokens, input.target_budget]
      .find((value) => Number.isFinite(value) && (value as number) > 0);
    const targetBudget = Number.isFinite(requestedBudget)
      ? Math.max(1, Math.min(contextWindow, Math.floor(requestedBudget as number)))
      : Number.isFinite(settings.historyBudgetTokens) && settings.historyBudgetTokens > 0
        ? Math.floor(settings.historyBudgetTokens)
        : Math.floor(contextWindow * settings.budgetRatio);
    const rootDir = normalizeRootDirForAgent(resolveRootDir(input, agentId, context), agentId);
    const sessionMessages = parseRuntimeSessionMessages(input._runtime_context);
    const prompt = resolvePrompt(input, sessionMessages);
    const ledgerPath = resolveLedgerPath(rootDir, sessionId, agentId, 'main');
    const rebuildResult = await forceRebuild(
      sessionId,
      ledgerPath,
      'topic',
      prompt,
      tokenizeUserInput(prompt),
      targetBudget,
      sessionMessages,
    );

    if (rebuildResult.ok === false) {
      return {
        ok: false,
        action: 'skipped',
        reason: 'rebuild_failed',
        sessionId,
        agentId,
        targetBudget,
        selectedBlockIds: [],
        metadata: {
          ...rebuildResult.metadata,
          ...(typeof rebuildResult.error === 'string' ? { error: rebuildResult.error } : {}),
        },
      };
    }

    sessionRebuildTimestamps.set(sessionId, Date.now());
    const includeMessages = input.include_messages === true;
    const messageLimit = Number.isFinite(input.message_limit)
      ? Math.max(1, Math.min(120, Math.floor(input.message_limit as number)))
      : 40;
    const selectedBlockIds = rebuildResult.messages
      .filter((message) => message.metadata?.compactDigest === true)
      .map((message) => message.id);

    log.info('Context builder rebuild completed', {
      sessionId,
      agentId,
      targetBudget,
      digestCount: rebuildResult.digestCount,
      rawMessageCount: rebuildResult.rawMessageCount,
      totalTokens: rebuildResult.totalTokens,
    });

    return {
      ok: true,
      action: 'rebuild',
      sessionId,
      agentId,
      targetBudget,
      buildMode: rebuildResult.mode,
      metadata: {
        ...rebuildResult.metadata,
        rebuildMode: rebuildResult.mode,
        digestCount: rebuildResult.digestCount,
        rawMessageCount: rebuildResult.rawMessageCount,
        totalTokens: rebuildResult.totalTokens,
      },
      selectedBlockIds,
      appliesNextTurn: true,
      ...(includeMessages
        ? {
            messages: rebuildResult.messages.slice(-messageLimit).map((message) => ({
              id: message.id,
              role: message.role,
              tokenCount: typeof message.metadata?.tokenCount === 'number' ? Math.floor(message.metadata.tokenCount) : 0,
              ...(typeof message.metadata?.contextZone === 'string'
                ? { contextZone: message.metadata.contextZone as 'working_set' | 'historical_memory' }
                : {}),
              contentPreview: message.content.length > 180 ? message.content.slice(0, 180) + '...' : message.content,
            })),
          }
        : {}),
      __rebuiltMessages: rebuildResult.messages,
    };
  },
};
