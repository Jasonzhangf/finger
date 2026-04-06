import { buildContextUsageLine } from './progress-monitor-utils.js';
import { resolveToolDisplayName } from './progress-monitor-reporting.js';
import type { SessionProgress, ToolCallRecord } from './progress-monitor-types.js';

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

export function isLowValueTask(task?: string): boolean {
  if (!task) return true;
  const normalized = task.toLowerCase();
  if (!normalized.trim()) return true;
  if (
    normalized.includes('mailbox.status')
    || normalized.includes('mailbox.list')
    || normalized.includes('mailbox.read')
    || normalized.includes('mailbox.ack')
  ) {
    return true;
  }
  if ([
    '处理中',
    '处理中…',
    '处理中...',
    '执行中',
    '等待中',
    '继续处理',
  ].includes(normalized)) {
    return true;
  }
  if (/^\s*cat\b/.test(normalized)) {
    return true;
  }
  return false;
}

export function extractCommandFromParams(params?: string): string {
  if (!params || params.trim().length === 0) return '';
  try {
    const parsed = JSON.parse(params) as Record<string, unknown>;
    if (typeof parsed.cmd === 'string') return parsed.cmd.trim();
    if (typeof parsed.command === 'string') return parsed.command.trim();
    if (typeof parsed.input === 'string') return parsed.input.trim();
    return '';
  } catch {
    return params;
  }
}

export function isLowValueToolCall(tool: ToolCallRecord, lowValueTools: Set<string>): boolean {
  const toolName = (tool.toolName || '').trim().toLowerCase();
  if (!toolName) return true;
  if (lowValueTools.has(toolName)) return true;

  if (toolName === 'exec_command' || toolName === 'shell.exec') {
    const command = extractCommandFromParams(tool.params).toLowerCase();
    if (!command.trim()) return true;
    if (/^\s*cat\b/.test(command)) return true;
    if (/^\s*(ls|pwd|head|tail|sed\s+-n|wc|stat)\b/.test(command)) return true;
  }

  return false;
}

export function shouldEmitHeartbeat(p: SessionProgress, now: number, intervalMs: number): boolean {
  if (p.status !== 'running') return false;
  const lastReportTime = p.lastReportTime ?? 0;
  if (now - lastReportTime < intervalMs) return false;
  return now - p.lastUpdateTime >= intervalMs;
}

export function findPendingMeaningfulTool(
  p: SessionProgress,
  lowValueTools: Set<string>,
): ToolCallRecord | undefined {
  return [...p.toolCallHistory]
    .reverse()
    .find((tool) => !isLowValueToolCall(tool, lowValueTools) && tool.success === undefined && !tool.result && !tool.error);
}

export function buildHeartbeatSummary(
  p: SessionProgress,
  now: number,
  pendingTool?: ToolCallRecord,
  options?: {
    suspectedStall?: boolean;
    waitLayer?: 'external' | 'internal';
    waitKind?: 'provider' | 'tool' | 'user' | 'unknown';
    waitDetail?: string;
    resetHintCommand?: string;
    lifecycleStage?: string;
    lifecycleDetail?: string;
    lifecycleAgeMs?: number;
  },
): string {
  const waitingMs = Math.max(0, now - p.lastUpdateTime);
  const localTime = new Date();
  const hh = String(localTime.getHours()).padStart(2, '0');
  const mm = String(localTime.getMinutes()).padStart(2, '0');
  const lines = [`📊 ${hh}:${mm} | 执行中`];
  if (options?.lifecycleStage) {
    const stage = options.lifecycleStage.trim();
    const detail = typeof options.lifecycleDetail === 'string' ? options.lifecycleDetail.trim() : '';
    const age = typeof options.lifecycleAgeMs === 'number' && Number.isFinite(options.lifecycleAgeMs) && options.lifecycleAgeMs >= 0
      ? ` · 持续 ${formatElapsed(options.lifecycleAgeMs)}`
      : '';
    lines.push(`🧠 内部阶段: ${stage}${detail ? ` · ${detail}` : ''}${age}`);
  }
  if (pendingTool) {
    const toolName = resolveToolDisplayName(pendingTool.toolName?.trim() || '工具', pendingTool.params);
    lines.push(`⏳ ${formatElapsed(waitingMs)} 无新事件，当前等待工具 ${toolName} 返回`);
  } else if (options?.suspectedStall) {
    lines.push(`⚠️ ${formatElapsed(waitingMs)} 无关键进展，疑似卡住`);
  } else {
    lines.push(`⏳ ${formatElapsed(waitingMs)} 无新事件，当前轮仍在运行`);
  }

  if (options?.waitLayer === 'external') {
    if (options.waitKind === 'provider') {
      lines.push(`🌐 分层状态: 外部等待 · provider 响应中${options.waitDetail ? ` (${options.waitDetail})` : ''}`);
    } else if (options.waitKind === 'tool') {
      lines.push(`🧩 分层状态: 外部等待 · 工具执行中${options.waitDetail ? ` (${options.waitDetail})` : ''}`);
    } else if (options.waitKind === 'user') {
      lines.push(`👤 分层状态: 外部等待 · 等待用户输入${options.waitDetail ? ` (${options.waitDetail})` : ''}`);
    } else {
      lines.push(`🌐 分层状态: 外部等待${options.waitDetail ? ` (${options.waitDetail})` : ''}`);
    }
  } else if (options?.waitLayer === 'internal') {
    lines.push(`⚠️ 分层状态: 内部等待 · 未检测到外部阻塞信号${options.waitDetail ? ` (${options.waitDetail})` : ''}`);
    if (options.resetHintCommand && options.resetHintCommand.trim().length > 0) {
      lines.push(`🔁 重置命令: ${options.resetHintCommand.trim()}`);
    }
  }

  const contextLine = buildContextUsageLine({
    contextUsagePercent: p.contextUsagePercent,
    estimatedTokensInContextWindow: p.estimatedTokensInContextWindow,
    maxInputTokens: p.maxInputTokens,
  });
  if (contextLine) {
    lines.push(contextLine);
  }

  return lines.join('\n');
}
