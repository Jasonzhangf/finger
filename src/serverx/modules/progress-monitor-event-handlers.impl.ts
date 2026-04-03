/**
 * Progress Monitor - Event Handlers
 *
 * Extracted event handling logic from progress-monitor.ts.
 */

import type { SessionProgress, ToolCallRecord } from '../../server/modules/progress-monitor-types.js';
import { resolveToolDisplayName } from '../../server/modules/progress-monitor-reporting.js';
import { estimateTokensWithTiktoken } from '../../utils/tiktoken-estimator.js';

function normalizeNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return undefined;
}

function normalizeStringArray(value: unknown, maxItems = 32): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter((item) => item.length > 0);
  if (normalized.length === 0) return undefined;
  return [...new Set(normalized)].slice(0, Math.max(1, maxItems));
}

function parseContextBreakdown(payload: Record<string, unknown> | undefined): SessionProgress['contextBreakdown'] | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const raw = (typeof payload.contextBreakdown === 'object' && payload.contextBreakdown !== null)
    ? payload.contextBreakdown as Record<string, unknown>
    : (typeof payload.context_breakdown === 'object' && payload.context_breakdown !== null)
      ? payload.context_breakdown as Record<string, unknown>
      : undefined;
  if (!raw) return undefined;

  const historyContextTokens = normalizeNonNegativeInt(raw.historyContextTokens ?? raw.history_context_tokens);
  const historyCurrentTokens = normalizeNonNegativeInt(raw.historyCurrentTokens ?? raw.history_current_tokens);
  const historyTotalTokens = normalizeNonNegativeInt(raw.historyTotalTokens ?? raw.history_total_tokens);
  const historyContextMessages = normalizeNonNegativeInt(raw.historyContextMessages ?? raw.history_context_messages);
  const historyCurrentMessages = normalizeNonNegativeInt(raw.historyCurrentMessages ?? raw.history_current_messages);
  const systemPromptTokens = normalizeNonNegativeInt(raw.systemPromptTokens ?? raw.system_prompt_tokens);
  const developerPromptTokens = normalizeNonNegativeInt(raw.developerPromptTokens ?? raw.developer_prompt_tokens);
  const userInstructionsTokens = normalizeNonNegativeInt(raw.userInstructionsTokens ?? raw.user_instructions_tokens);
  const environmentContextTokens = normalizeNonNegativeInt(raw.environmentContextTokens ?? raw.environment_context_tokens);
  const turnContextTokens = normalizeNonNegativeInt(raw.turnContextTokens ?? raw.turn_context_tokens);
  const skillsTokens = normalizeNonNegativeInt(raw.skillsTokens ?? raw.skills_tokens);
  const mailboxTokens = normalizeNonNegativeInt(raw.mailboxTokens ?? raw.mailbox_tokens);
  const projectTokens = normalizeNonNegativeInt(raw.projectTokens ?? raw.project_tokens);
  const flowTokens = normalizeNonNegativeInt(raw.flowTokens ?? raw.flow_tokens);
  const contextSlotsTokens = normalizeNonNegativeInt(raw.contextSlotsTokens ?? raw.context_slots_tokens);
  const inputTextTokens = normalizeNonNegativeInt(raw.inputTextTokens ?? raw.input_text_tokens);
  const inputMediaTokens = normalizeNonNegativeInt(raw.inputMediaTokens ?? raw.input_media_tokens);
  const inputMediaCount = normalizeNonNegativeInt(raw.inputMediaCount ?? raw.input_media_count);
  const inputTotalTokens = normalizeNonNegativeInt(raw.inputTotalTokens ?? raw.input_total_tokens);
  const toolsSchemaTokens = normalizeNonNegativeInt(raw.toolsSchemaTokens ?? raw.tools_schema_tokens);
  const toolExecutionTokens = normalizeNonNegativeInt(raw.toolExecutionTokens ?? raw.tool_execution_tokens);
  const contextLedgerConfigTokens = normalizeNonNegativeInt(raw.contextLedgerConfigTokens ?? raw.context_ledger_config_tokens);
  const responsesConfigTokens = normalizeNonNegativeInt(raw.responsesConfigTokens ?? raw.responses_config_tokens);
  const totalKnownTokens = normalizeNonNegativeInt(raw.totalKnownTokens ?? raw.total_known_tokens);
  const source = typeof raw.source === 'string' ? raw.source.trim() : '';

  if (
    historyContextTokens === undefined
    && historyCurrentTokens === undefined
    && historyTotalTokens === undefined
    && historyContextMessages === undefined
    && historyCurrentMessages === undefined
    && systemPromptTokens === undefined
    && developerPromptTokens === undefined
    && userInstructionsTokens === undefined
    && environmentContextTokens === undefined
    && turnContextTokens === undefined
    && skillsTokens === undefined
    && mailboxTokens === undefined
    && projectTokens === undefined
    && flowTokens === undefined
    && contextSlotsTokens === undefined
    && inputTextTokens === undefined
    && inputMediaTokens === undefined
    && inputMediaCount === undefined
    && inputTotalTokens === undefined
    && toolsSchemaTokens === undefined
    && toolExecutionTokens === undefined
    && contextLedgerConfigTokens === undefined
    && responsesConfigTokens === undefined
    && totalKnownTokens === undefined
    && source.length === 0
  ) {
    return undefined;
  }

  return {
    ...(historyContextTokens !== undefined ? { historyContextTokens } : {}),
    ...(historyCurrentTokens !== undefined ? { historyCurrentTokens } : {}),
    ...(historyTotalTokens !== undefined ? { historyTotalTokens } : {}),
    ...(historyContextMessages !== undefined ? { historyContextMessages } : {}),
    ...(historyCurrentMessages !== undefined ? { historyCurrentMessages } : {}),
    ...(systemPromptTokens !== undefined ? { systemPromptTokens } : {}),
    ...(developerPromptTokens !== undefined ? { developerPromptTokens } : {}),
    ...(userInstructionsTokens !== undefined ? { userInstructionsTokens } : {}),
    ...(environmentContextTokens !== undefined ? { environmentContextTokens } : {}),
    ...(turnContextTokens !== undefined ? { turnContextTokens } : {}),
    ...(skillsTokens !== undefined ? { skillsTokens } : {}),
    ...(mailboxTokens !== undefined ? { mailboxTokens } : {}),
    ...(projectTokens !== undefined ? { projectTokens } : {}),
    ...(flowTokens !== undefined ? { flowTokens } : {}),
    ...(contextSlotsTokens !== undefined ? { contextSlotsTokens } : {}),
    ...(inputTextTokens !== undefined ? { inputTextTokens } : {}),
    ...(inputMediaTokens !== undefined ? { inputMediaTokens } : {}),
    ...(inputMediaCount !== undefined ? { inputMediaCount } : {}),
    ...(inputTotalTokens !== undefined ? { inputTotalTokens } : {}),
    ...(toolsSchemaTokens !== undefined ? { toolsSchemaTokens } : {}),
    ...(toolExecutionTokens !== undefined ? { toolExecutionTokens } : {}),
    ...(contextLedgerConfigTokens !== undefined ? { contextLedgerConfigTokens } : {}),
    ...(responsesConfigTokens !== undefined ? { responsesConfigTokens } : {}),
    ...(totalKnownTokens !== undefined ? { totalKnownTokens } : {}),
    ...(source.length > 0 ? { source } : {}),
  };
}

function buildProgressEntryKey(progress: SessionProgress): string {
  return `${progress.sessionId}::${progress.agentId || 'unknown'}`;
}

function joinTokenParts(parts: Array<string | undefined>): string {
  return parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part.length > 0)
    .join('\n');
}

function inferEstimatedFromPercent(
  percent: number | undefined,
  maxInputTokens: number | undefined,
): number | undefined {
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) return undefined;
  if (typeof maxInputTokens !== 'number' || !Number.isFinite(maxInputTokens) || maxInputTokens <= 0) return undefined;
  return Math.max(0, Math.floor((percent / 100) * maxInputTokens));
}

function resolveContextBaselineTokens(progress: SessionProgress): number | undefined {
  if (typeof progress.contextUsageBaseTokens === 'number' && Number.isFinite(progress.contextUsageBaseTokens)) {
    return Math.max(0, Math.floor(progress.contextUsageBaseTokens));
  }
  if (
    typeof progress.estimatedTokensInContextWindow === 'number'
    && Number.isFinite(progress.estimatedTokensInContextWindow)
  ) {
    return Math.max(0, Math.floor(progress.estimatedTokensInContextWindow));
  }
  if (
    typeof progress.contextBreakdown?.totalKnownTokens === 'number'
    && Number.isFinite(progress.contextBreakdown.totalKnownTokens)
    && progress.contextBreakdown.totalKnownTokens >= 0
  ) {
    return Math.max(0, Math.floor(progress.contextBreakdown.totalKnownTokens));
  }
  if (
    typeof progress.contextUsagePercent === 'number'
    && Number.isFinite(progress.contextUsagePercent)
    && progress.contextUsagePercent >= 0
    && typeof progress.maxInputTokens === 'number'
    && Number.isFinite(progress.maxInputTokens)
    && progress.maxInputTokens > 0
  ) {
    return Math.max(0, Math.floor((progress.contextUsagePercent / 100) * progress.maxInputTokens));
  }
  return undefined;
}

function applyAddedContextTokens(progress: SessionProgress, text: string): void {
  const normalized = text.trim();
  if (!normalized) return;
  const addedTokens = estimateTokensWithTiktoken(normalized);
  if (!Number.isFinite(addedTokens) || addedTokens <= 0) return;

  const baseTokens = resolveContextBaselineTokens(progress);
  if (baseTokens === undefined) return;
  const currentAdded = typeof progress.contextUsageAddedTokens === 'number' && Number.isFinite(progress.contextUsageAddedTokens)
    ? Math.max(0, Math.floor(progress.contextUsageAddedTokens))
    : 0;
  const nextAdded = currentAdded + addedTokens;
  const nextEstimated = baseTokens + nextAdded;
  progress.contextUsageBaseTokens = baseTokens;
  progress.contextUsageAddedTokens = nextAdded;
  progress.estimatedTokensInContextWindow = nextEstimated;
  if (typeof progress.maxInputTokens === 'number' && Number.isFinite(progress.maxInputTokens) && progress.maxInputTokens > 0) {
    progress.contextUsagePercent = Math.max(0, Math.floor((nextEstimated / progress.maxInputTokens) * 100));
  }
  applyAddedTokensToContextBreakdown(progress, addedTokens);
}

function applyAddedTokensToContextBreakdown(progress: SessionProgress, addedTokens: number): void {
  const breakdown = progress.contextBreakdown;
  if (!breakdown) return;
  if (!Number.isFinite(addedTokens) || addedTokens <= 0) return;
  const delta = Math.max(0, Math.floor(addedTokens));
  if (delta <= 0) return;

  const currentHistoryCurrent = typeof breakdown.historyCurrentTokens === 'number' && Number.isFinite(breakdown.historyCurrentTokens)
    ? Math.max(0, Math.floor(breakdown.historyCurrentTokens))
    : 0;
  const nextHistoryCurrent = currentHistoryCurrent + delta;
  breakdown.historyCurrentTokens = nextHistoryCurrent;

  const historyContext = typeof breakdown.historyContextTokens === 'number' && Number.isFinite(breakdown.historyContextTokens)
    ? Math.max(0, Math.floor(breakdown.historyContextTokens))
    : 0;
  breakdown.historyTotalTokens = historyContext + nextHistoryCurrent;

  if (typeof breakdown.totalKnownTokens === 'number' && Number.isFinite(breakdown.totalKnownTokens)) {
    breakdown.totalKnownTokens = Math.max(0, Math.floor(breakdown.totalKnownTokens)) + delta;
  } else {
    breakdown.totalKnownTokens = breakdown.historyTotalTokens;
  }
}

function mergeContextBreakdown(
  progress: SessionProgress,
  incoming: NonNullable<SessionProgress['contextBreakdown']>,
  options?: { allowDrop?: boolean },
): void {
  const allowDrop = options?.allowDrop === true;
  const existing = progress.contextBreakdown;
  if (!existing || allowDrop) {
    progress.contextBreakdown = { ...incoming };
    return;
  }

  const merged: SessionProgress['contextBreakdown'] = { ...existing };
  const numericKeys: Array<keyof NonNullable<SessionProgress['contextBreakdown']>> = [
    'historyContextTokens',
    'historyCurrentTokens',
    'historyTotalTokens',
    'historyContextMessages',
    'historyCurrentMessages',
    'systemPromptTokens',
    'developerPromptTokens',
    'userInstructionsTokens',
    'environmentContextTokens',
    'turnContextTokens',
    'skillsTokens',
    'mailboxTokens',
    'projectTokens',
    'flowTokens',
    'contextSlotsTokens',
    'inputTextTokens',
    'inputMediaTokens',
    'inputMediaCount',
    'inputTotalTokens',
    'toolsSchemaTokens',
    'toolExecutionTokens',
    'contextLedgerConfigTokens',
    'responsesConfigTokens',
    'totalKnownTokens',
  ];

  for (const key of numericKeys) {
    const next = incoming[key];
    const prev = merged[key];
    const nextNum = typeof next === 'number' && Number.isFinite(next) ? Math.max(0, Math.floor(next)) : undefined;
    const prevNum = typeof prev === 'number' && Number.isFinite(prev) ? Math.max(0, Math.floor(prev)) : undefined;
    if (nextNum === undefined) continue;
    if (prevNum === undefined) {
      (merged as Record<string, unknown>)[key] = nextNum;
      continue;
    }
    (merged as Record<string, unknown>)[key] = Math.max(prevNum, nextNum);
  }

  if (typeof incoming.source === 'string' && incoming.source.trim().length > 0) {
    merged.source = incoming.source.trim();
  }
  progress.contextBreakdown = merged;
}

function setContextEvent(progress: SessionProgress, detail: string): void {
  const normalized = detail.trim();
  if (!normalized) return;
  progress.lastContextEvent = normalized;
  progress.lastContextEventAt = Date.now();
}

/**
 * 安全截取字符串
 */
export function safeSnippet(value: unknown, limit = 200): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > limit ? text.slice(0, limit) + '...' : text;
  } catch {
    const text = String(value);
    return text.length > limit ? text.slice(0, limit) + '...' : text;
  }
}

/**
 * 获取工具的snippet限制
 */
export function snippetLimitForTool(toolName?: string): number {
  // Jason 要求：update_plan 进度明细不截断（在可控内存上限内尽量保留完整）。
  if (toolName === 'update_plan') return 200_000;
  return 200;
}

/**
 * 记录工具调用
 */
export function recordToolCall(
  progress: SessionProgress,
  toolId?: string,
  toolName?: string,
  input?: unknown,
): void {
  const nextSeq = (progress.toolSeqCounter ?? 0) + 1;
  progress.toolSeqCounter = nextSeq;
  const record: ToolCallRecord = {
    seq: nextSeq,
    toolId,
    toolName: toolName || 'unknown',
    params: safeSnippet(input, snippetLimitForTool(toolName)),
    timestamp: Date.now(),
  };
  progress.toolCallHistory.push(record);
  if (progress.toolCallHistory.length > 10) {
    progress.toolCallHistory.shift();
  }
}

/**
 * 记录工具结果
 */
export function recordToolResult(
  progress: SessionProgress,
  toolId?: string,
  toolName?: string,
  input?: unknown,
  output?: unknown,
  error?: string,
  success?: boolean,
): void {
  // 先按 toolId 查找
  let existing = toolId
    ? progress.toolCallHistory.find(t => t.toolId === toolId && !t.result && !t.error)
    : undefined;

  // 如果按 toolId 找不到，按 toolName 查找最近的未完成记录
  if (!existing && toolName) {
    const inputSnippet = safeSnippet(input, snippetLimitForTool(toolName));
    // 从后往前找最后一个未完成的同名工具
    for (let i = progress.toolCallHistory.length - 1; i >= 0; i--) {
      const t = progress.toolCallHistory[i];
      if (
        t.toolName === toolName
        && !t.result
        && !t.error
        && (inputSnippet === undefined || t.params === inputSnippet)
      ) {
        existing = t;
        break;
      }
    }

    // 若带参数匹配失败，再降级到同名匹配
    if (!existing) {
      for (let i = progress.toolCallHistory.length - 1; i >= 0; i--) {
        const t = progress.toolCallHistory[i];
        if (t.toolName === toolName && !t.result && !t.error) {
          existing = t;
          break;
        }
      }
    }
  }

  let record: ToolCallRecord;
  if (existing) {
    record = existing;
    if (typeof record.seq !== 'number' || !Number.isFinite(record.seq)) {
      const nextSeq = (progress.toolSeqCounter ?? 0) + 1;
      progress.toolSeqCounter = nextSeq;
      record.seq = nextSeq;
    }
  } else {
    const nextSeq = (progress.toolSeqCounter ?? 0) + 1;
    progress.toolSeqCounter = nextSeq;
    record = {
      seq: nextSeq,
      toolId,
      toolName: toolName || 'unknown',
      params: safeSnippet(input, snippetLimitForTool(toolName)),
      timestamp: Date.now(),
    };
  }
  const snippetLimit = snippetLimitForTool(toolName);
  record.result = output !== undefined ? safeSnippet(output, snippetLimit) : record.result;
  record.error = error ? safeSnippet(error, snippetLimit) : record.error;
  record.success = success;
  if (!existing) {
    progress.toolCallHistory.push(record);
  }
  if (progress.toolCallHistory.length > 10) {
    progress.toolCallHistory.shift();
  }
  const displayName = resolveToolDisplayName(record.toolName, record.params);
  progress.currentTask = `${displayName} → ${success ? '✅' : '❌'}`;
}

/**
 * 处理 turn_start 事件
 */
export function handleTurnStart(progress: SessionProgress, event: any): void {
  progress.status = 'running';
  progress.hasOpenTurn = true;
  const payload = event?.payload && typeof event.payload === 'object'
    ? event.payload as Record<string, unknown>
    : undefined;
  if (payload) {
    const parsedBreakdown = parseContextBreakdown(payload);
    if (parsedBreakdown) {
      mergeContextBreakdown(progress, parsedBreakdown);
      if (
        typeof progress.estimatedTokensInContextWindow !== 'number'
        && typeof parsedBreakdown.totalKnownTokens === 'number'
        && Number.isFinite(parsedBreakdown.totalKnownTokens)
      ) {
        progress.estimatedTokensInContextWindow = Math.max(0, Math.floor(parsedBreakdown.totalKnownTokens));
      }
    }
    const contextUsagePercentRaw = typeof payload.contextUsagePercent === 'number'
      ? payload.contextUsagePercent
      : typeof payload.context_usage_percent === 'number'
        ? payload.context_usage_percent
        : undefined;
    const estimatedTokensRaw = typeof payload.estimatedTokensInContextWindow === 'number'
      ? payload.estimatedTokensInContextWindow
      : typeof payload.estimated_tokens_in_context_window === 'number'
        ? payload.estimated_tokens_in_context_window
        : undefined;
    const maxInputTokensRaw = typeof payload.maxInputTokens === 'number'
      ? payload.maxInputTokens
      : typeof payload.max_input_tokens === 'number'
        ? payload.max_input_tokens
        : typeof payload.modelContextWindow === 'number'
          ? payload.modelContextWindow
          : typeof payload.model_context_window === 'number'
            ? payload.model_context_window
            : undefined;
    if (typeof contextUsagePercentRaw === 'number' && Number.isFinite(contextUsagePercentRaw)) {
      progress.contextUsagePercent = Math.max(0, Math.floor(contextUsagePercentRaw));
    }
    if (typeof estimatedTokensRaw === 'number' && Number.isFinite(estimatedTokensRaw)) {
      progress.estimatedTokensInContextWindow = Math.max(0, Math.floor(estimatedTokensRaw));
    }
    if (typeof maxInputTokensRaw === 'number' && Number.isFinite(maxInputTokensRaw)) {
      progress.maxInputTokens = Math.max(1, Math.floor(maxInputTokensRaw));
    }
    if (typeof progress.estimatedTokensInContextWindow === 'number' && Number.isFinite(progress.estimatedTokensInContextWindow)) {
      progress.contextUsageBaseTokens = Math.max(0, Math.floor(progress.estimatedTokensInContextWindow));
      progress.contextUsageAddedTokens = 0;
    }
  }
  if (typeof event.payload?.reasoning === 'string' && event.payload.reasoning.length > 0) {
    progress.latestReasoning = event.payload.reasoning.slice(0, 120);
  }
}

/**
 * 处理 turn_complete 事件
 */
export function handleTurnComplete(progress: SessionProgress, event: any): void {
  if (typeof event.payload?.reasoning === 'string' && event.payload.reasoning.length > 0) {
    progress.latestReasoning = event.payload.reasoning.slice(0, 120);
  }
  const payload = event?.payload && typeof event.payload === 'object'
    ? event.payload as Record<string, unknown>
    : undefined;
  if (payload) {
    const controlBlock = payload.controlBlock && typeof payload.controlBlock === 'object'
      ? payload.controlBlock as Record<string, unknown>
      : undefined;
    const controlTags = normalizeStringArray(controlBlock?.tags, 48);
    if (controlTags) progress.controlTags = controlTags;
    const controlHooks = normalizeStringArray(payload.controlHookNames, 48);
    if (controlHooks) progress.controlHookNames = controlHooks;
    if (typeof payload.controlBlockValid === 'boolean') {
      progress.controlBlockValid = payload.controlBlockValid;
    }
    const issues = normalizeStringArray(payload.controlBlockIssues, 16);
    if (issues) progress.controlIssues = issues;
  }
  // A turn is finished; switch to idle so periodic progress heartbeat
  // does not keep pushing when there is no active execution.
  progress.hasOpenTurn = false;
  progress.status = 'idle';
}

/**
 * 处理 tool_call 事件
 */
export function handleToolCallEvent(
  progress: SessionProgress,
  event: any,
): void {
  if (progress.status !== 'completed' && progress.status !== 'failed') {
    progress.status = 'running';
  }
  progress.toolCallsCount++;
  recordToolCall(progress, event.toolId, event.toolName, event.payload?.input);
  applyAddedContextTokens(
    progress,
    joinTokenParts([
      event.toolName,
      safeSnippet(event.payload?.input, snippetLimitForTool(event.toolName)),
    ]),
  );
}

/**
 * 处理 tool_result 事件
 */
export function handleToolResultEvent(
  progress: SessionProgress,
  event: any,
): void {
  if (progress.status !== 'completed' && progress.status !== 'failed') {
    progress.status = 'running';
  }
  recordToolResult(progress, event.toolId, event.toolName, event.payload?.input, event.payload?.output, undefined, true);
  if (event.toolName) {
    const resolved = resolveToolDisplayName(event.toolName, event.payload?.input);
    progress.currentTask = `${resolved} → ✅`;
  }
  if (event.toolName === 'context_builder.rebuild') {
    progress.allowContextDropOnce = true;
    setContextEvent(progress, '手动执行 context_builder.rebuild，准备重组历史上下文');
  } else if (event.toolName === 'context_ledger.expand_task') {
    setContextEvent(progress, '扩展任务摘要为全文片段，补充当前上下文细节');
  }
  applyAddedContextTokens(
    progress,
    joinTokenParts([
      event.toolName,
      safeSnippet(event.payload?.input, snippetLimitForTool(event.toolName)),
      safeSnippet(event.payload?.output),
    ]),
  );
}

/**
 * 处理 tool_error 事件
 */
export function handleToolErrorEvent(
  progress: SessionProgress,
  event: any,
): void {
  if (progress.status !== 'completed' && progress.status !== 'failed') {
    progress.status = 'running';
  }
  recordToolResult(progress, event.toolId, event.toolName, event.payload?.input, undefined, event.payload?.error, false);
  if (event.toolName) {
    const resolved = resolveToolDisplayName(event.toolName, event.payload?.input);
    progress.currentTask = `${resolved} → ❌`;
  }
  applyAddedContextTokens(
    progress,
    joinTokenParts([
      event.toolName,
      safeSnippet(event.payload?.input, snippetLimitForTool(event.toolName)),
      safeSnippet(event.payload?.error),
    ]),
  );
}

/**
 * 处理 model_round 事件
 */
export function handleModelRound(progress: SessionProgress, event: any): void {
  if (progress.status !== 'completed' && progress.status !== 'failed') {
    progress.status = 'running';
  }
  progress.hasOpenTurn = true;
  progress.modelRoundsCount++;
  if (event.payload?.reasoning_count) {
    progress.reasoningCount += event.payload.reasoning_count;
  }
  if (typeof event.payload?.reasoning === 'string' && event.payload.reasoning.length > 0) {
    progress.latestReasoning = event.payload.reasoning.slice(0, 120);
  }
  const parsedBreakdown = parseContextBreakdown(
    event?.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : undefined,
  );
  if (parsedBreakdown) {
    mergeContextBreakdown(progress, parsedBreakdown);
  }
  const contextUsagePercentRaw = typeof event.payload?.contextUsagePercent === 'number'
    ? event.payload.contextUsagePercent
    : typeof event.payload?.context_usage_percent === 'number'
      ? event.payload.context_usage_percent
      : undefined;
  const estimatedTokensRaw = typeof event.payload?.estimatedTokensInContextWindow === 'number'
    ? event.payload.estimatedTokensInContextWindow
    : typeof event.payload?.estimated_tokens_in_context_window === 'number'
      ? event.payload.estimated_tokens_in_context_window
      : undefined;
  const maxInputTokensRaw = typeof event.payload?.maxInputTokens === 'number'
    ? event.payload.maxInputTokens
    : typeof event.payload?.max_input_tokens === 'number'
      ? event.payload.max_input_tokens
      : undefined;
  const inputTokensRaw = typeof event.payload?.inputTokens === 'number'
    ? event.payload.inputTokens
    : typeof event.payload?.input_tokens === 'number'
      ? event.payload.input_tokens
      : undefined;
  const totalTokensRaw = typeof event.payload?.totalTokens === 'number'
    ? event.payload.totalTokens
    : typeof event.payload?.total_tokens === 'number'
      ? event.payload.total_tokens
      : undefined;

  const normalizedPercent = typeof contextUsagePercentRaw === 'number' && Number.isFinite(contextUsagePercentRaw)
    ? Math.max(0, Math.floor(contextUsagePercentRaw))
    : undefined;
  const normalizedMaxInput = typeof maxInputTokensRaw === 'number' && Number.isFinite(maxInputTokensRaw)
    ? Math.max(0, Math.floor(maxInputTokensRaw))
    : (typeof progress.maxInputTokens === 'number' && Number.isFinite(progress.maxInputTokens)
      ? Math.max(0, Math.floor(progress.maxInputTokens))
      : undefined);
  // baseline = model-round usage for current context window:
  // prefer explicit estimatedTokensInContextWindow, fallback to usage.input_tokens, then total_tokens.
  const usageEstimatedRaw = estimatedTokensRaw ?? inputTokensRaw ?? totalTokensRaw;
  let normalizedEstimated = typeof usageEstimatedRaw === 'number' && Number.isFinite(usageEstimatedRaw)
    ? Math.max(0, Math.floor(usageEstimatedRaw))
    : undefined;
  if (normalizedEstimated === undefined) {
    normalizedEstimated = inferEstimatedFromPercent(normalizedPercent, normalizedMaxInput);
  }
  const canDrop = progress.allowContextDropOnce === true;
  const currentPercent = typeof progress.contextUsagePercent === 'number' ? progress.contextUsagePercent : undefined;
  const shouldApplyPercent =
    normalizedPercent !== undefined
    && (currentPercent === undefined || normalizedPercent >= currentPercent || canDrop);
  if (shouldApplyPercent) {
    const dropped = currentPercent !== undefined && normalizedPercent < currentPercent;
    progress.contextUsagePercent = normalizedPercent;
    if (normalizedEstimated !== undefined) {
      progress.estimatedTokensInContextWindow = normalizedEstimated;
    }
    if (canDrop && currentPercent !== undefined && normalizedPercent < currentPercent) {
      progress.allowContextDropOnce = false;
    }
    if (dropped && canDrop) {
      const currentTokens = typeof progress.contextUsageBaseTokens === 'number' ? progress.contextUsageBaseTokens : undefined;
      const nextTokens = normalizedEstimated;
      const left = typeof currentPercent === 'number' ? `${currentPercent}%` : '?';
      const right = `${normalizedPercent}%`;
      const tokenPart = typeof currentTokens === 'number' && typeof nextTokens === 'number'
        ? `（~${currentTokens} → ~${nextTokens}）`
        : '';
      setContextEvent(progress, `上下文已重组：${left} → ${right}${tokenPart}`);
    }
  } else if (normalizedEstimated !== undefined) {
    const currentEstimated = typeof progress.estimatedTokensInContextWindow === 'number'
      ? progress.estimatedTokensInContextWindow
      : undefined;
    if (currentEstimated === undefined || normalizedEstimated >= currentEstimated) {
      progress.estimatedTokensInContextWindow = normalizedEstimated;
    }
  }
  if (typeof maxInputTokensRaw === 'number' && Number.isFinite(maxInputTokensRaw)) {
    progress.maxInputTokens = Math.max(0, Math.floor(maxInputTokensRaw));
  }
  if (typeof progress.estimatedTokensInContextWindow === 'number' && Number.isFinite(progress.estimatedTokensInContextWindow)) {
    progress.contextUsageBaseTokens = Math.max(0, Math.floor(progress.estimatedTokensInContextWindow));
    progress.contextUsageAddedTokens = 0;
  }
}

/**
 * 处理 system_notice 事件
 */
export function handleSystemNoticeEvent(progress: SessionProgress, event: any): void {
  if (progress.status !== 'completed' && progress.status !== 'failed') {
    progress.status = 'running';
  }
  const payload = event?.payload ?? {};
  const source = typeof payload.source === 'string' ? payload.source : '';
  const parsedBreakdown = parseContextBreakdown(
    payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined,
  );
  const shouldAllowBreakdownDrop = source === 'auto_context_rebuild'
    || source === 'manual_context_rebuild'
    || source === 'session_compressed';
  if (parsedBreakdown) {
    mergeContextBreakdown(progress, parsedBreakdown, { allowDrop: shouldAllowBreakdownDrop });
  }
  const contextUsagePercentRaw = typeof payload.contextUsagePercent === 'number'
    ? payload.contextUsagePercent
    : typeof payload.context_usage_percent === 'number'
      ? payload.context_usage_percent
      : undefined;
  const estimatedTokensRaw = typeof payload.estimatedTokensInContextWindow === 'number'
    ? payload.estimatedTokensInContextWindow
    : typeof payload.estimated_tokens_in_context_window === 'number'
      ? payload.estimated_tokens_in_context_window
      : undefined;
  const maxInputTokensRaw = typeof payload.maxInputTokens === 'number'
    ? payload.maxInputTokens
    : typeof payload.max_input_tokens === 'number'
      ? payload.max_input_tokens
      : undefined;
  const inputTokensRaw = typeof payload.inputTokens === 'number'
    ? payload.inputTokens
    : typeof payload.input_tokens === 'number'
      ? payload.input_tokens
      : undefined;
  const totalTokensRaw = typeof payload.totalTokens === 'number'
    ? payload.totalTokens
    : typeof payload.total_tokens === 'number'
      ? payload.total_tokens
      : undefined;

  if (source === 'auto_context_rebuild' || source === 'manual_context_rebuild' || source === 'session_compressed') {
    progress.allowContextDropOnce = true;
    const trigger = source === 'auto_context_rebuild'
      ? '自动 context rebuild'
      : source === 'manual_context_rebuild'
        ? '手动 context rebuild'
        : 'session 压缩';
    const percentLabel = typeof contextUsagePercentRaw === 'number' && Number.isFinite(contextUsagePercentRaw)
      ? `${Math.max(0, Math.floor(contextUsagePercentRaw))}%`
      : '';
    const reason = percentLabel ? `${trigger}（触发时上下文 ${percentLabel}）` : trigger;
    setContextEvent(progress, reason);
  }

  const normalizedPercent = typeof contextUsagePercentRaw === 'number' && Number.isFinite(contextUsagePercentRaw)
    ? Math.max(0, Math.floor(contextUsagePercentRaw))
    : undefined;
  const normalizedMaxInput = typeof maxInputTokensRaw === 'number' && Number.isFinite(maxInputTokensRaw)
    ? Math.max(0, Math.floor(maxInputTokensRaw))
    : (typeof progress.maxInputTokens === 'number' && Number.isFinite(progress.maxInputTokens)
      ? Math.max(0, Math.floor(progress.maxInputTokens))
      : undefined);
  const usageEstimatedRaw = estimatedTokensRaw ?? inputTokensRaw ?? totalTokensRaw;
  let normalizedEstimated = typeof usageEstimatedRaw === 'number' && Number.isFinite(usageEstimatedRaw)
    ? Math.max(0, Math.floor(usageEstimatedRaw))
    : undefined;
  if (normalizedEstimated === undefined) {
    normalizedEstimated = inferEstimatedFromPercent(normalizedPercent, normalizedMaxInput);
  }
  const canDrop = progress.allowContextDropOnce === true;
  const currentPercent = typeof progress.contextUsagePercent === 'number' ? progress.contextUsagePercent : undefined;
  const shouldApplyPercent =
    normalizedPercent !== undefined
    && (currentPercent === undefined || normalizedPercent >= currentPercent || canDrop);
  if (shouldApplyPercent) {
    progress.contextUsagePercent = normalizedPercent;
    if (normalizedEstimated !== undefined) {
      progress.estimatedTokensInContextWindow = normalizedEstimated;
    }
    if (canDrop && currentPercent !== undefined && normalizedPercent < currentPercent) {
      progress.allowContextDropOnce = false;
    }
  } else if (normalizedEstimated !== undefined) {
    const currentEstimated = typeof progress.estimatedTokensInContextWindow === 'number'
      ? progress.estimatedTokensInContextWindow
      : undefined;
    if (currentEstimated === undefined || normalizedEstimated >= currentEstimated) {
      progress.estimatedTokensInContextWindow = normalizedEstimated;
    }
  }
  if (typeof maxInputTokensRaw === 'number' && Number.isFinite(maxInputTokensRaw)) {
    progress.maxInputTokens = Math.max(0, Math.floor(maxInputTokensRaw));
  }
  if (
    source === 'auto_context_rebuild'
    || source === 'manual_context_rebuild'
    || source === 'session_compressed'
  ) {
    if (typeof progress.estimatedTokensInContextWindow === 'number' && Number.isFinite(progress.estimatedTokensInContextWindow)) {
      progress.contextUsageBaseTokens = Math.max(0, Math.floor(progress.estimatedTokensInContextWindow));
      progress.contextUsageAddedTokens = 0;
    }
  }
}

/**
 * 处理 session_compressed 事件
 */
export function handleSessionCompressedEvent(progress: SessionProgress, event?: any): void {
  if (progress.status !== 'completed' && progress.status !== 'failed') {
    progress.status = 'running';
  }
  progress.allowContextDropOnce = true;
  const payload = event?.payload ?? {};
  const trigger = typeof payload.trigger === 'string' ? payload.trigger.trim() : '';
  const percent = typeof payload.contextUsagePercent === 'number' && Number.isFinite(payload.contextUsagePercent)
    ? Math.max(0, Math.floor(payload.contextUsagePercent))
    : undefined;
  const fromSize = typeof payload.originalSize === 'number' && Number.isFinite(payload.originalSize)
    ? Math.max(0, Math.floor(payload.originalSize))
    : undefined;
  const toSize = typeof payload.compressedSize === 'number' && Number.isFinite(payload.compressedSize)
    ? Math.max(0, Math.floor(payload.compressedSize))
    : undefined;
  const triggerLabel = trigger ? `session 压缩(${trigger})` : 'session 压缩';
  const sizeLabel = typeof fromSize === 'number' && typeof toSize === 'number'
    ? `，消息 ${fromSize} → ${toSize}`
    : '';
  const percentLabel = typeof percent === 'number' ? `，触发时上下文 ${percent}%` : '';
  setContextEvent(progress, `${triggerLabel}${percentLabel}${sizeLabel}`);
}

/**
 * 处理 agent_runtime_status 事件
 */
export function handleAgentRuntimeStatus(progress: SessionProgress, event: any): void {
  const status = event.payload?.status;
  if (status === 'completed') {
    progress.hasOpenTurn = false;
    progress.status = 'completed';
  } else if (status === 'failed') {
    progress.hasOpenTurn = false;
    progress.status = 'failed';
  } else if (status === 'idle') {
    progress.hasOpenTurn = false;
    progress.status = 'idle';
  }
  if (event.payload?.summary) {
    progress.currentTask = event.payload.summary;
  }
}

/**
 * 处理 agent_runtime_dispatch 事件
 */
export function handleAgentRuntimeDispatch(progress: SessionProgress, event: any): void {
  const target = event.payload?.targetAgentId;
  const status = typeof event.payload?.status === 'string' ? event.payload.status : 'queued';
  const isTerminal = status === 'completed' || status === 'failed' || status === 'idle';

  // Self-target dispatch updates are authoritative for turn closure.
  // Do not drop them, otherwise progress can stay "running" forever when
  // model_round close event is missing but dispatch already completed.
  if (target && target === progress.agentId) {
    if (isTerminal) {
      progress.hasOpenTurn = false;
      progress.status = status as SessionProgress['status'];
      progress.currentTask = `派发 ${target} (${status})`;
    }
    return;
  }

  // Skip heartbeat/bootstrap dispatches only (system dispatch is now business-critical).
  const source = event.payload?.sourceAgentId || (event as any).sourceAgentId || '';
  if (source.includes('heartbeat') || source.includes('bootstrap')) {
    return;
  }
  if (target) {
    progress.currentTask = `派发 ${target} (${status})`;
    if (status === 'failed') progress.status = 'failed';
  }
}

/**
 * 处理 agent_step_completed 事件
 */
export function handleAgentStepCompleted(
  progress: SessionProgress,
  event: any,
  latestStepSummary: Map<string, string>,
): void {
  if (progress.status !== 'completed' && progress.status !== 'failed') {
    progress.status = 'running';
  }
  progress.modelRoundsCount++;
  const payload = event.payload as { round?: number; thought?: string; action?: string; observation?: string };
  const parts: string[] = [];
  if (payload.thought) parts.push(payload.thought);
  if (payload.action) parts.push(payload.action);
  if (payload.thought) {
    progress.latestReasoning = payload.thought.slice(0, 120);
  }
  const progressKey = buildProgressEntryKey(progress);
  latestStepSummary.set(progressKey, parts.join(' → ') || `步骤 ${payload.round ?? '?'}`);
  progress.currentTask = latestStepSummary.get(progressKey);
}
