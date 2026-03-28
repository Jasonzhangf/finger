/**
 * Progress Monitor - Event Handlers
 *
 * Extracted event handling logic from progress-monitor.ts.
 */

import type { SessionProgress, ToolCallRecord } from './progress-monitor-types.js';
import { resolveToolDisplayName } from './progress-monitor-reporting.js';

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
  progress.toolCallsCount++;
  recordToolCall(progress, event.toolId, event.toolName, event.payload?.input);
}

/**
 * 处理 tool_result 事件
 */
export function handleToolResultEvent(
  progress: SessionProgress,
  event: any,
): void {
  recordToolResult(progress, event.toolId, event.toolName, event.payload?.input, event.payload?.output, undefined, true);
  if (event.toolName) {
    const resolved = resolveToolDisplayName(event.toolName, event.payload?.input);
    progress.currentTask = `${resolved} → ✅`;
  }
}

/**
 * 处理 tool_error 事件
 */
export function handleToolErrorEvent(
  progress: SessionProgress,
  event: any,
): void {
  recordToolResult(progress, event.toolId, event.toolName, event.payload?.input, undefined, event.payload?.error, false);
  if (event.toolName) {
    const resolved = resolveToolDisplayName(event.toolName, event.payload?.input);
    progress.currentTask = `${resolved} → ❌`;
  }
}

/**
 * 处理 model_round 事件
 */
export function handleModelRound(progress: SessionProgress, event: any): void {
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

  if (typeof contextUsagePercentRaw === 'number' && Number.isFinite(contextUsagePercentRaw)) {
    progress.contextUsagePercent = Math.max(0, Math.floor(contextUsagePercentRaw));
  }
  if (typeof estimatedTokensRaw === 'number' && Number.isFinite(estimatedTokensRaw)) {
    progress.estimatedTokensInContextWindow = Math.max(0, Math.floor(estimatedTokensRaw));
  }
  if (typeof maxInputTokensRaw === 'number' && Number.isFinite(maxInputTokensRaw)) {
    progress.maxInputTokens = Math.max(0, Math.floor(maxInputTokensRaw));
  }
}

/**
 * 处理 system_notice 事件
 */
export function handleSystemNoticeEvent(progress: SessionProgress, event: any): void {
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

  if (typeof contextUsagePercentRaw === 'number' && Number.isFinite(contextUsagePercentRaw)) {
    progress.contextUsagePercent = Math.max(0, Math.floor(contextUsagePercentRaw));
  }
  if (typeof estimatedTokensRaw === 'number' && Number.isFinite(estimatedTokensRaw)) {
    progress.estimatedTokensInContextWindow = Math.max(0, Math.floor(estimatedTokensRaw));
  }
  if (typeof maxInputTokensRaw === 'number' && Number.isFinite(maxInputTokensRaw)) {
    progress.maxInputTokens = Math.max(0, Math.floor(maxInputTokensRaw));
  }
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
  progress.modelRoundsCount++;
  const payload = event.payload as { round?: number; thought?: string; action?: string; observation?: string };
  const parts: string[] = [];
  if (payload.thought) parts.push(payload.thought);
  if (payload.action) parts.push(payload.action);
  if (payload.thought) {
    progress.latestReasoning = payload.thought.slice(0, 120);
  }
  latestStepSummary.set(progress.sessionId, parts.join(' → ') || `步骤 ${payload.round ?? '?'}`);
  progress.currentTask = latestStepSummary.get(progress.sessionId);
}
