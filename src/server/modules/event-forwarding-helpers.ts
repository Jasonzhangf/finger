import { isObjectRecord } from '../common/object.js';

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
