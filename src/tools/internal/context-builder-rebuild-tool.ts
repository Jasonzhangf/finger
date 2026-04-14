import { join } from 'path';
import { buildContext } from '../../runtime/context-builder.js';
import { getContextWindow, loadContextBuilderSettings } from '../../core/user-settings.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { setContextBuilderOnDemandView } from '../../runtime/context-builder-on-demand-state.js';
import type { InternalTool, ToolExecutionContext } from './types.js';

import { acquireSessionLock, releaseSessionLock, hasSessionLock } from '../../runtime/context-history/lock.js';
import { logger } from '../../core/logger.js';

const log = logger.module('ContextBuilderRebuild');

const REBUILD_RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes
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

interface RuntimeContextSessionMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
  attachments?: unknown[];
}

interface ContextBuilderRebuildOutput {
  ok: boolean;
  action: 'rebuild' | 'skipped';
  reason?: 'rebuild_already_in_progress' | 'lock_acquisition_failed';
  sessionId: string;
  agentId: string;
  buildMode?: 'minimal' | 'moderate' | 'aggressive';
  targetBudget: number;
  metadata?: Record<string, unknown>;
  selectedBlockIds: string[];
  appliesNextTurn?: boolean;
  messages?: Array<{
    id: string;
    role: string;
    tokenCount: number;
    contextZone?: 'working_set' | 'historical_memory';
    contentPreview: string;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

function parseRuntimeSessionMessages(
  runtimeContext: Record<string, unknown> | undefined,
): RuntimeContextSessionMessage[] | undefined {
  const raw = runtimeContext?.session_messages;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const parsed = raw
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
    .map((item, index) => {
      const roleRaw = typeof item.role === 'string' ? item.role.trim() : '';
      const role: RuntimeContextSessionMessage['role'] =
        roleRaw === 'assistant' || roleRaw === 'system'
          ? roleRaw
          : 'user';
      const content = typeof item.content === 'string' ? item.content : '';
      const timestamp = typeof item.timestamp === 'string' && item.timestamp.trim().length > 0
        ? item.timestamp
        : new Date(Date.now() + index).toISOString();
      const metadata = item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
        ? item.metadata as Record<string, unknown>
        : undefined;
      const attachments = Array.isArray(item.attachments) ? item.attachments : undefined;
      return {
        ...(typeof item.id === 'string' && item.id.trim().length > 0 ? { id: item.id } : {}),
        role,
        content,
        timestamp,
        ...(metadata ? { metadata } : {}),
        ...(attachments ? { attachments } : {}),
      } satisfies RuntimeContextSessionMessage;
    })
    .filter((item) => item.content.trim().length > 0);
  return parsed.length > 0 ? parsed : undefined;
}

export const contextBuilderRebuildTool: InternalTool<unknown, ContextBuilderRebuildOutput> = {
  name: 'context_builder.rebuild',
  executionModel: 'state',
  description: [
    'Rebuild dynamic history context from ledger for the current session.',
    '',
    '⚠️ CRITICAL: This tool should ONLY be called in USER INPUT rounds (when user sends a message).',
    'DO NOT call this tool during tool execution loops or model response rounds.',
    '',
    'Trigger rules (conservative):',
    '- Only call when user explicitly switches to a NEW topic',
    '- Do NOT call for consecutive rounds of the SAME task',
    '- Rate limit: max 1 call per 5 minutes per session',
    '',
    'Valid scenarios:',
    '- User says "lets talk about something else" or "next topic"',
    '- User request is completely unrelated to current task',
    '- control_block.new_topic=true detected in user input',
    '',
    'Invalid scenarios (DO NOT call):',
    '- Same task continuation ("continue", "next step")',
    '- Tool execution loops',
    '- Heartbeat/system tasks',
    '',
    'Default history budget is 20k tokens.',
    'For coding tasks: try rebuild_budget=50000 first, 110000 only if 50k insufficient.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Optional session id override. Defaults to current tool context session.' },
      agent_id: { type: 'string', description: 'Optional agent id override. Defaults to current tool context agent.' },
      mode: { type: 'string', enum: ['minimal', 'moderate', 'aggressive'], description: 'Context build mode override for this rebuild.' },
      target_budget: { type: 'number', description: 'Optional token budget override for this rebuild. Default is 20k when not configured otherwise.' },
      rebuild_budget: { type: 'number', description: 'Preferred alias for rebuild token budget. Recommended ladder: 50k first for coding tasks, 110k only when 50k is insufficient.' },
      budget_tokens: { type: 'number', description: 'Alias for rebuild token budget; same meaning as rebuild_budget/target_budget.' },
      current_prompt: { type: 'string', description: 'Current user intent/topic used for relevance sorting.' },
      include_messages: { type: 'boolean', description: 'Whether to include compact message previews in tool output.' },
      message_limit: { type: 'number', description: 'Max preview messages when include_messages=true (default 40, max 120).' },
      _runtime_context: { type: 'object', description: 'Optional runtime context bridge (session/agent/root_dir).' },
    },
    additionalProperties: true,
  },
  execute: async (rawInput: unknown, context: ToolExecutionContext): Promise<ContextBuilderRebuildOutput> => {
    const input = parseInput(rawInput);
    const sessionId = (input.session_id ?? context.sessionId ?? '').trim();
    if (!sessionId) {
      throw new Error('context_builder.rebuild requires session_id (or active tool context sessionId)');
    }


    // Rate limit: 5 minutes per session
    const lastRebuildTime = sessionRebuildTimestamps.get(sessionId) || 0;
    const elapsedSinceLastRebuild = Date.now() - lastRebuildTime;
    if (elapsedSinceLastRebuild < REBUILD_RATE_LIMIT_MS) {
      log.warn('Rebuild rate limited', { sessionId, elapsedSeconds: Math.floor(elapsedSinceLastRebuild / 1000) });
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
    // 检查是否已有 rebuild 锁
    if (hasSessionLock(sessionId)) {
      log.warn('Rebuild already in progress, skipping', { sessionId });
      return {
        ok: false,
        action: 'skipped',
        reason: 'rebuild_already_in_progress',
    sessionRebuildTimestamps.set(sessionId, Date.now());
        sessionId,
        agentId: context.agentId ?? 'finger-system-agent',
        targetBudget: 0,
        selectedBlockIds: [],
      };
    }

    // 获取 rebuild 锁
    await acquireSessionLock(sessionId, 'rebuild');

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
    const buildMode = input.mode ?? settings.mode;
    const rootDir = resolveRootDir(input, agentId, context);
    const sessionMessages = parseRuntimeSessionMessages(input._runtime_context);

    const built = await buildContext(
      {
        rootDir,
        sessionId,
        agentId,
        mode: 'main',
        currentPrompt: input.current_prompt,
        ...(sessionMessages ? { sessionMessages } : {}),
      },
      {
        targetBudget,
        buildMode,
        includeMemoryMd: false,
        enableTaskGrouping: true,
        rebuildTrigger: 'manual',
        enableModelRanking: settings.enableModelRanking,
        rankingProviderId: settings.rankingProviderId,
      },
    );

    setContextBuilderOnDemandView({
      sessionId,
      agentId,
      mode: 'main',
      buildMode,
      targetBudget,
      selectedBlockIds: built.rankedTaskBlocks.map((block) => block.id),
      metadata: built.metadata,
      messages: built.messages,
      createdAt: new Date().toISOString(),
    });

    const includeMessages = input.include_messages === true;
    const messageLimit = Number.isFinite(input.message_limit)
      ? Math.max(1, Math.min(120, Math.floor(input.message_limit as number)))
      : 40;

    try {
      return {
        ok: true,
        action: 'rebuild',
        sessionId,
        agentId,
        buildMode,
        targetBudget,
        metadata: built.metadata,
        selectedBlockIds: built.rankedTaskBlocks.map((block) => block.id),
        appliesNextTurn: true,
        ...(includeMessages
          ? {
            messages: built.messages.slice(-messageLimit).map((message) => ({
              id: message.id,
              role: message.role,
              tokenCount: message.tokenCount,
              ...(message.contextZone ? { contextZone: message.contextZone } : {}),
              contentPreview: message.content.length > 180 ? `${message.content.slice(0, 180)}...` : message.content,
            })),
          }
          : {}),
      };
    } finally {
      // 释放 rebuild 锁
      releaseSessionLock(sessionId);
      log.info('Rebuild lock released', { sessionId });
    }
  },
};
