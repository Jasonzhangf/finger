/**
 * Progress Monitor - Event Handlers
 *
 * Extracted event handling logic from progress-monitor.ts.
 */

import type { SessionProgress, ToolCallRecord } from './progress-monitor-types.js';
import { resolveToolDisplayName } from './progress-monitor-reporting.js';
import { estimateTokensWithTiktoken } from '../../utils/tiktoken-estimator.js';

function buildProgressEntryKey(progress: SessionProgress): string {
  return `${progress.sessionId}::${progress.agentId || 'unknown'}`;
}

function joinTokenParts(parts: Array<string | undefined>): string {
  return parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part.length > 0)
    .join('\n');
}

function applyAddedContextTokens(progress: SessionProgress, text: string): void {
  const normalized = text.trim();
  if (!normalized) return;
  const addedTokens = estimateTokensWithTiktoken(normalized);
  if (!Number.isFinite(addedTokens) || addedTokens <= 0) return;

  const baseTokens = typeof progress.contextUsageBaseTokens === 'number' && Number.isFinite(progress.contextUsageBaseTokens)
    ? Math.max(0, Math.floor(progress.contextUsageBaseTokens))
    : typeof progress.estimatedTokensInContextWindow === 'number' && Number.isFinite(progress.estimatedTokensInContextWindow)
      ? Math.max(0, Math.floor(progress.estimatedTokensInContextWindow))
      : 0;
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
  if (toolName === 'update_plan') return 12_000;
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
  record.result = output !== undefined ? safeSnippet(output) : record.result;
  record.error = error ? safeSnippet(error) : record.error;
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
  // A turn is finished; switch to idle so periodic progress heartbeat
  // does not keep pushing when there is no active execution.
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
  progress.modelRoundsCount++;
  if (event.payload?.reasoning_count) {
    progress.reasoningCount += event.payload.reasoning_count;
  }
  if (typeof event.payload?.reasoning === 'string' && event.payload.reasoning.length > 0) {
    progress.latestReasoning = event.payload.reasoning.slice(0, 120);
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
  // baseline = model-round usage for current context window:
  // prefer explicit estimatedTokensInContextWindow, fallback to usage.input_tokens, then total_tokens.
  const usageEstimatedRaw = estimatedTokensRaw ?? inputTokensRaw ?? totalTokensRaw;
  const normalizedEstimated = typeof usageEstimatedRaw === 'number' && Number.isFinite(usageEstimatedRaw)
    ? Math.max(0, Math.floor(usageEstimatedRaw))
    : undefined;
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

  const source = typeof payload.source === 'string' ? payload.source : '';
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
  const usageEstimatedRaw = estimatedTokensRaw ?? inputTokensRaw ?? totalTokensRaw;
  const normalizedEstimated = typeof usageEstimatedRaw === 'number' && Number.isFinite(usageEstimatedRaw)
    ? Math.max(0, Math.floor(usageEstimatedRaw))
    : undefined;
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
    progress.status = 'completed';
  } else if (status === 'failed') {
    progress.status = 'failed';
  } else if (status === 'idle') {
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
  // Skip heartbeat/bootstrap dispatches only (system dispatch is now business-critical).
  const source = event.payload?.sourceAgentId || (event as any).sourceAgentId || '';
  if (source.includes('heartbeat') || source.includes('bootstrap')) {
    return;
  }
  // Skip self-dispatch (system agent dispatching to itself)
  const target = event.payload?.targetAgentId;
  if (target && target === progress.agentId) {
    return;
  }
  if (target) {
    const status = event.payload?.status || 'queued';
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
