import { isObjectRecord } from '../common/object.js';
import { sanitizeDispatchResult } from '../../common/agent-dispatch.js';
import type { AgentStepCompletedEvent } from '../../runtime/events.js';
import { normalizeRootDir, resolveLedgerPath } from '../../runtime/context-ledger-memory-helpers.js';

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function inferAgentRoleLabel(agentId: string): string {
  const normalized = agentId.trim().toLowerCase();
  if (normalized.includes('orchestr')) return 'orchestrator';
  if (normalized.includes('review')) return 'reviewer';
  if (normalized.includes('search')) return 'searcher';
  if (normalized.includes('executor')) return 'executor';
  return 'executor';
}

export function formatDispatchResultContent(result: unknown, error?: string): string {
  if (typeof error === 'string' && error.trim().length > 0) {
    return `任务失败：${error.trim()}`;
  }
  const summarized = sanitizeDispatchResult(result);
  const summary = summarized.summary.trim();
  if (summary.length > 0) {
    const fileSuffix = summarized.keyFiles && summarized.keyFiles.length > 0
      ? `\n关键文件:\n${summarized.keyFiles.map((item) => `- ${item}`).join('\n')}`
      : '';
    return `${summary}${fileSuffix}`;
  }
  if (typeof result === 'string') {
    const trimmed = result.trim();
    if (trimmed.length > 0) return trimmed;
  }
  if (isObjectRecord(result)) {
    const response = typeof result.response === 'string' ? result.response.trim() : '';
    if (response.length > 0) return response;
    const output = typeof result.output === 'string' ? result.output.trim() : '';
    if (output.length > 0) return output;
    if (isObjectRecord(result.output) && typeof result.output.response === 'string') {
      const nested = result.output.response.trim();
      if (nested.length > 0) return nested;
    }
  }
  if (result !== undefined) {
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  return error ? `任务失败：${error}` : '任务完成';
}

export function buildDispatchFeedbackPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const summarized = sanitizeDispatchResult(payload.result);
  return {
    role: 'user',
    from: typeof payload.targetAgentId === 'string' ? payload.targetAgentId : 'unknown-assignee',
    status: payload.status === 'completed' ? 'complete' : 'error',
    dispatchId: typeof payload.dispatchId === 'string' ? payload.dispatchId : '',
    ...(typeof summarized.childSessionId === 'string' ? { childSessionId: summarized.childSessionId } : {}),
    summary: summarized.summary,
    result: summarized,
    ...(typeof payload.sourceAgentId === 'string' ? { sourceAgentId: payload.sourceAgentId } : {}),
    ...(typeof payload.error === 'string' && payload.error.trim().length > 0 ? { error: payload.error } : {}),
  };
}

export interface LoopToolTraceItem {
  callId?: string;
  tool: string;
  status: 'ok' | 'error';
  input?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

export function extractLoopToolTrace(raw: unknown): LoopToolTraceItem[] {
  if (!Array.isArray(raw)) return [];
  const items: LoopToolTraceItem[] = [];
  for (const entry of raw) {
    if (!isObjectRecord(entry)) continue;
    const tool = typeof entry.tool === 'string' ? entry.tool.trim() : '';
    if (!tool) continue;
    const status: LoopToolTraceItem['status'] = entry.status === 'error' ? 'error' : 'ok';
    const callId = typeof entry.callId === 'string' && entry.callId.trim().length > 0
      ? entry.callId.trim()
      : typeof entry.call_id === 'string' && entry.call_id.trim().length > 0
        ? entry.call_id.trim()
        : undefined;
    const error = typeof entry.error === 'string' && entry.error.trim().length > 0 ? entry.error.trim() : undefined;
    const durationMs = typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs)
      ? Math.round(entry.durationMs)
      : typeof entry.duration_ms === 'number' && Number.isFinite(entry.duration_ms)
        ? Math.round(entry.duration_ms)
        : undefined;
    items.push({
      ...(callId ? { callId } : {}),
      tool,
      status,
      ...(entry.input !== undefined ? { input: entry.input } : {}),
      ...(entry.output !== undefined ? { output: entry.output } : {}),
      ...(error ? { error } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  }
  return items;
}

export function buildAgentStepContent(payload: AgentStepCompletedEvent['payload']): string {
  const parts: string[] = [];
  if (typeof payload.thought === 'string' && payload.thought.trim().length > 0) {
    parts.push(`思考: ${payload.thought.trim()}`);
  }
  if (typeof payload.action === 'string' && payload.action.trim().length > 0) {
    parts.push(`动作: ${payload.action.trim()}`);
  }
  if (typeof payload.observation === 'string' && payload.observation.trim().length > 0) {
    parts.push(`观察: ${payload.observation.trim()}`);
  }
  if (parts.length === 0) {
    return 'agent step 完成';
  }
  return parts.join('\n');
}

export interface LedgerPointerInfo {
  sessionId: string;
  agentId: string;
  mode: string;
  rootDir: string;
  ledgerPath: string;
}

export function buildLedgerPointerInfo(params: {
  sessionId: string;
  agentId: string;
  mode?: string;
  rootDir?: string;
}): LedgerPointerInfo {
  const rootDir = normalizeRootDir(params.rootDir);
  const mode = params.mode && params.mode.trim().length > 0 ? params.mode.trim() : 'main';
  const ledgerPath = resolveLedgerPath(rootDir, params.sessionId, params.agentId, mode);
  return {
    sessionId: params.sessionId,
    agentId: params.agentId,
    mode,
    rootDir,
    ledgerPath,
  };
}

export function formatLedgerPointerContent(info: LedgerPointerInfo, label: string): string {
  return `[ledger_pointer:${label}] session=${info.sessionId} agent=${info.agentId} mode=${info.mode} root=${info.rootDir} path=${info.ledgerPath}`;
}
