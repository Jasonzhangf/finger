/**
 * Progress Monitor - Tool Classification & File Extraction Utilities
 *
 * Extracted from progress-monitor.ts to keep file under 500 lines.
 */

import { getContextWindow } from '../../core/user-settings.js';
import type { ContextBreakdownSnapshot } from './progress-monitor-types.js';

export type ToolCategory = '读写' | '搜索' | '工具' | '其他';

function parseToolPayload(input?: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      return { cmd: input };
    }
    return { cmd: input };
  }
  if (typeof input === 'object' && input !== null) return input as Record<string, unknown>;
  return {};
}

function extractExecLikeCommand(input?: unknown): string {
  const payload = parseToolPayload(input);

  if (typeof payload.cmd === 'string' && payload.cmd.trim().length > 0) {
    return payload.cmd.trim();
  }

  const command = payload.command;
  if (typeof command === 'string' && command.trim().length > 0) {
    return command.trim();
  }
  if (Array.isArray(command)) {
    const parts = command.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    if (parts.length > 0) return parts.join(' ').trim();
  }

  if (typeof payload.input === 'string' && payload.input.trim().length > 0) {
    return payload.input.trim();
  }

  return '';
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function extractPathFromCommand(cmd: string): string {
  const normalized = cmd.trim();
  if (!normalized) return '';

  // Handle shell wrappers: bash -c "...", sh -lc '...'
  const shellWrapper = normalized.match(/^(?:\/bin\/)?(?:bash|sh|zsh)\s+-[a-zA-Z]+\s+(.+)$/);
  if (shellWrapper && shellWrapper[1]) {
    const nested = stripWrappingQuotes(shellWrapper[1]);
    const nestedPath = extractPathFromCommand(nested);
    if (nestedPath) return nestedPath;
  }

  const tokens = normalized.match(/[^\s|;'"<>]+/g) || [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (!t || t === '&&' || t === '||') continue;
    if (t.startsWith('-')) continue;
    if (t.includes('/')) return t;
    if (/\.[a-zA-Z]{1,8}$/.test(t)) return t;
  }
  return '';
}

/**
 * Classify a tool call into a human-readable category.
 */
export function classifyToolCall(toolName: string, input?: unknown): ToolCategory {
  // 搜索类优先
  if (['web_search', 'web_search_results'].includes(toolName)) return '搜索';
  if (toolName === 'report-task-completion') return '工具';

  if (['shell.exec', 'exec_command', 'command.exec'].includes(toolName)) {
    const cmd = extractExecLikeCommand(input);
    const lower = cmd.toLowerCase();

    if (/^<##/.test(cmd.trim())) {
      return '工具';
    }

    if (/^(rg|grep|ag|fd|fzf|find)\b/.test(lower) || /\b(search|grep|rg|find|locate)\b/.test(lower)) {
      return '搜索';
    }

    if (/\b(write|save|create|delete|remove|move|copy|install|npm|pnpm|git\s+(commit|add|push|checkout)|mkdir|touch|echo\s+.*>|tee|mv|cp)\b/.test(lower)) {
      return '读写';
    }

    if (/^(cat|head|tail|less|more|sed\s+-n|ls\b|find\b|rg\b|grep\b|wc\b|file\b|stat\b|tree\b|which\b|type\b)/.test(lower)
      || /\b(read|show|list|get|check|dump|print|display)\b/.test(lower)) {
      return '读写';
    }

    if (/^echo\b/.test(lower)) {
      return '工具';
    }
  }

  if (['apply_patch', 'write_stdin'].includes(toolName)) return '读写';

  if (/^(agent\.|context_ledger|context_builder|memsearch|update_plan|clock\.|user\.|bd\b)/.test(toolName)) return '工具';

  return '其他';
}

/**
 * Extract a meaningful file/dir name from tool input.
 */
export function extractTargetFile(toolName: string, input?: unknown): string {
  const obj = parseToolPayload(input);

  if (Object.keys(obj).length === 0) return '';

  if (toolName === 'apply_patch' && obj.patch) {
    const patchStr = String(obj.patch);
    // Try apply_patch format first: *** Update File: path
    const updateFileMatch = patchStr.match(/^\*{3}\s+Update\s+File:\s*(\S+)/m);
    if (updateFileMatch) return updateFileMatch[1];
    // Try unified diff format: --- a/path
    const m = patchStr.match(/^--- a\/(\S+)/m);
    return m ? m[1] : '';
  }

  if ('cmd' in obj || 'command' in obj) {
    const cmd = extractExecLikeCommand(obj);
    return extractPathFromCommand(cmd);
  }

  if ('file' in obj && typeof obj.file === 'string') return obj.file;
  if ('filepath' in obj && typeof obj.filepath === 'string') return obj.filepath;
  if ('filename' in obj && typeof obj.filename === 'string') return obj.filename;
  if ('dir' in obj && typeof obj.dir === 'string') return obj.dir;
  if ('directory' in obj && typeof obj.directory === 'string') return obj.directory;

  if ('paths' in obj && Array.isArray(obj.paths)) {
    const firstPath = obj.paths.find((item): item is string => typeof item === 'string' && item.trim().length > 0);
    if (firstPath) return firstPath;
  }


  if ('path' in obj && typeof obj.path === 'string') {
    return obj.path;
  }

  if ('workdir' in obj && typeof obj.workdir === 'string') {
    return obj.workdir;
  }

  return '';
}

export interface SessionProgressData {
  agentId: string;
  status: string;
  currentTask?: string;
  elapsedMs: number;
  toolCallHistory: Array<{
    toolName: string;
    params?: string;
    result?: string;
    success?: boolean;
  }>;
  latestReasoning?: string;
  contextUsagePercent?: number;
  estimatedTokensInContextWindow?: number;
  maxInputTokens?: number;
  lastContextEvent?: string;
  contextBreakdown?: ContextBreakdownSnapshot;
  contextBreakdownMode?: 'release' | 'dev';
  controlTags?: string[];
  controlHookNames?: string[];
  controlBlockValid?: boolean;
  controlIssues?: string[];
}

function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return String(value);
  if (value >= 1000) {
    const compact = (value / 1000).toFixed(value >= 100000 ? 0 : 1);
    return `${compact.replace(/\.0$/, '')}k`;
  }
  return String(Math.floor(value));
}

export interface ContextUsageSnapshot {
  contextUsagePercent?: number;
  estimatedTokensInContextWindow?: number;
  maxInputTokens?: number;
}

export function buildContextUsageLine(snapshot: ContextUsageSnapshot): string | undefined {
  const configuredWindow = getContextWindow();
  const maxInput = typeof snapshot.maxInputTokens === 'number' && Number.isFinite(snapshot.maxInputTokens)
    ? Math.max(1, Math.floor(snapshot.maxInputTokens))
    : Math.max(1, Math.floor(configuredWindow));

  const explicitEstimated = typeof snapshot.estimatedTokensInContextWindow === 'number'
    && Number.isFinite(snapshot.estimatedTokensInContextWindow)
    ? Math.max(0, Math.floor(snapshot.estimatedTokensInContextWindow))
    : undefined;

  const explicitPercent = typeof snapshot.contextUsagePercent === 'number'
    && Number.isFinite(snapshot.contextUsagePercent)
    ? Math.max(0, Math.floor(snapshot.contextUsagePercent))
    : undefined;

  const inferredEstimated = explicitEstimated !== undefined
    ? explicitEstimated
    : explicitPercent !== undefined
      ? Math.max(0, Math.floor((explicitPercent / 100) * maxInput))
      : undefined;

  const inferredPercent = explicitPercent !== undefined
    ? explicitPercent
    : inferredEstimated !== undefined
      ? Math.max(0, Math.floor((inferredEstimated / Math.max(1, maxInput)) * 100))
      : undefined;
  const derivedPercentFromEstimated = inferredEstimated !== undefined
    ? Math.max(0, Math.floor((inferredEstimated / Math.max(1, maxInput)) * 100))
    : undefined;
  const drift = inferredPercent !== undefined && derivedPercentFromEstimated !== undefined
    ? Math.abs(inferredPercent - derivedPercentFromEstimated)
    : 0;
  const preferPercentDerivedTokens =
    explicitPercent !== undefined
    && explicitEstimated !== undefined
    && derivedPercentFromEstimated !== undefined
    && drift >= 3;
  const normalizedPercent = (() => {
    if (preferPercentDerivedTokens) return explicitPercent;
    if (inferredPercent === undefined) return derivedPercentFromEstimated;
    if (derivedPercentFromEstimated === undefined) return inferredPercent;
    return inferredPercent;
  })();
  const normalizedEstimated = preferPercentDerivedTokens
    ? Math.max(0, Math.floor((explicitPercent as number / 100) * maxInput))
    : inferredEstimated;

  if (inferredEstimated === undefined && normalizedPercent === undefined) {
    return undefined;
  }

  const estimatedLabel = explicitEstimated === undefined && normalizedEstimated !== undefined
    ? `~${formatTokenCount(normalizedEstimated)}`
    : formatTokenCount(normalizedEstimated ?? 0);
  const percentLabel = normalizedPercent !== undefined
    ? (normalizedPercent === 0 && (normalizedEstimated ?? 0) > 0 ? '<1%' : `${normalizedPercent}%`)
    : undefined;

  if (normalizedEstimated !== undefined && percentLabel !== undefined) {
    return `🧠 上下文: ${percentLabel} · ${estimatedLabel}/${formatTokenCount(maxInput)}`;
  }
  if (normalizedEstimated !== undefined) {
    return `🧠 上下文: ${estimatedLabel}/${formatTokenCount(maxInput)}`;
  }
  return `🧠 上下文: ${percentLabel ?? '?'} · ?/${formatTokenCount(maxInput)}`;
}

export function normalizeContextUsageSnapshot(snapshot: ContextUsageSnapshot): Required<Pick<ContextUsageSnapshot, 'maxInputTokens'>> & ContextUsageSnapshot {
  const configuredWindow = Math.max(1, Math.floor(getContextWindow()));
  const maxInputTokens = typeof snapshot.maxInputTokens === 'number' && Number.isFinite(snapshot.maxInputTokens)
    ? Math.max(1, Math.floor(snapshot.maxInputTokens))
    : configuredWindow;
  return {
    ...snapshot,
    maxInputTokens,
  };
}

// Backward-compatible re-exports: reporting helpers were split into progress-monitor-reporting.ts
// but existing imports/tests still consume them from progress-monitor-utils.
export {
  buildCompactSummary,
  buildReportKey,
  resolveToolDisplayName,
} from './progress-monitor-reporting.js';
