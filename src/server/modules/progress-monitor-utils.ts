/**
 * Progress Monitor - Tool Classification & File Extraction Utilities
 *
 * Extracted from progress-monitor.ts to keep file under 500 lines.
 */

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

/**
 * Classify a tool call into a human-readable category.
 */
export function classifyToolCall(toolName: string, input?: unknown): ToolCategory {
  // 搜索类优先
  if (['web_search', 'web_search_results'].includes(toolName)) return '搜索';
  if (toolName === 'command.exec') return '工具';

  if (['shell.exec', 'exec_command'].includes(toolName)) {
    const cmd = extractExecLikeCommand(input);
    const lower = cmd.toLowerCase();

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
    if (!cmd) return '';
    // Match paths starting with ~ / . followed by file tokens
    const pathMatch = cmd.match(/(?:^|[\s|;])([~./][\w./@\-]*[\w./\-])(?:[\s|;]|$)/);
    if (pathMatch) return pathMatch[1];
    // Fallback: any token with a file extension
    const extMatch = cmd.match(/([\w./~][\w./\-]+\.[\w]{1,6})/);
    return extMatch ? extMatch[0] : '';
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
}

function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return String(value);
  if (value >= 1000) {
    const compact = (value / 1000).toFixed(value >= 100000 ? 0 : 1);
    return `${compact.replace(/\.0$/, '')}k`;
  }
  return String(Math.floor(value));
}

/**
 * Build a compact, mobile-readable progress summary for one session.
 */
export interface BuildCompactSummaryOptions {
  includeTask?: boolean;
  includeReasoning?: boolean;
  headerMode?: 'full' | 'minimal';
}

export function buildCompactSummary(
  p: SessionProgressData,
  formatElapsed: (ms: number) => string,
  options?: BuildCompactSummaryOptions,
): string {
  const includeTask = options?.includeTask ?? true;
  const includeReasoning = options?.includeReasoning ?? true;
  const headerMode = options?.headerMode ?? 'full';
  // Use local time instead of elapsed
  const now = new Date();
  const localTime = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const task = p.currentTask || '';
  const recentTools = p.toolCallHistory.slice(-5);

  const lines: string[] = [];
  if (headerMode === 'minimal') {
    lines.push(`📊 ${localTime} | ${p.status === 'running' ? '执行中' : p.status}`);
  } else {
    lines.push(`📊 ${localTime} | ${task || '执行中'}`);
  }

  if (includeTask && task) {
    lines.push(`🧭 ${task}`);
  }

  if (includeReasoning && p.latestReasoning) {
    lines.push(`💭 ${p.latestReasoning}`);
  }

  if (
    typeof p.contextUsagePercent === 'number'
    || typeof p.estimatedTokensInContextWindow === 'number'
    || typeof p.maxInputTokens === 'number'
  ) {
    const usagePercent = typeof p.contextUsagePercent === 'number'
      ? Math.max(0, Math.floor(p.contextUsagePercent))
      : undefined;
    const estimated = typeof p.estimatedTokensInContextWindow === 'number'
      ? Math.max(0, Math.floor(p.estimatedTokensInContextWindow))
      : undefined;
    const maxInput = typeof p.maxInputTokens === 'number'
      ? Math.max(0, Math.floor(p.maxInputTokens))
      : undefined;

    if (estimated !== undefined && maxInput !== undefined) {
      const percent = usagePercent !== undefined
        ? usagePercent
        : Math.max(0, Math.floor((estimated / Math.max(1, maxInput)) * 100));
      lines.push(`🧠 上下文: ${formatTokenCount(estimated)}/${formatTokenCount(maxInput)} (${percent}%)`);
    } else if (usagePercent !== undefined) {
      lines.push(`🧠 上下文: ${usagePercent}%`);
    } else if (estimated !== undefined) {
      lines.push(`🧠 上下文: ~${formatTokenCount(estimated)} tokens`);
    }
  }

  if (recentTools.length > 0) {
    const toolLines = recentTools.map((t) => {
      const icon = t.success === false ? '❌' : t.success === true ? '✅' : '⏳';
      const cat = classifyToolCall(t.toolName, t.params);
      const resolvedName = resolveToolDisplayName(t.toolName, t.params);
      const file = extractTargetFile(t.toolName, t.params);
      const filePart = file ? ` | ${file}` : '';
      const detail = extractToolDetail(t.toolName, t.params, t.result);
      const detailPart = detail ? ` ${detail}` : '';
      return `${icon} [${cat}] ${resolvedName}${filePart}${detailPart}`;
    });
    lines.push(toolLines.join('\n'));
  }

  return lines.join('\n');
}

/**
 * Extract a meaningful one-line detail from tool input for progress display.
 * Currently handles: update_plan, web_search, agent.dispatch, write_stdin.
 */
function extractToolDetail(
  toolName: string,
  params?: string,
  result?: string,
): string {
  if (!params && !result) return '';

  const parse = (raw: string): Record<string, unknown> => {
    if (!raw) return {};
    try {
      const obj = JSON.parse(raw);
      return typeof obj === 'object' && obj !== null ? obj as Record<string, unknown> : {};
    } catch {
      return {};
    }
  };

  const truncate = (text: string, max = 60): string => {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    return trimmed.length > max ? trimmed.slice(0, max - 1) + '\u2026' : trimmed;
  };

  // update_plan: show the in-progress or latest step
  if (toolName === 'update_plan') {
    const p = parse(params ?? '');
    const planItems = Array.isArray(p.plan) ? p.plan as Array<Record<string, unknown>> : [];
    if (planItems.length === 0) return '';
    const inProgress = planItems.find((item) => item.status === 'in_progress');
    if (inProgress && typeof inProgress.step === 'string') {
      return '\u25b6 ' + truncate(inProgress.step, 80);
    }
    // Show last step with status icon
    for (let i = planItems.length - 1; i >= 0; i--) {
      const step = planItems[i];
      if (typeof step.step === 'string') {
        const statusIcon = step.status === 'completed' ? '\u2713' : step.status === 'in_progress' ? '\u25b6' : '\u25cb';
        return statusIcon + ' ' + truncate(step.step, 60);
      }
    }
    return '';
  }

  // web_search: show the search query
  if (toolName === 'web_search' || toolName === 'search_query') {
    const p = parse(params ?? '');
    const query = typeof p.query === 'string' ? p.query.trim()
      : typeof p.q === 'string' ? p.q.trim()
      : '';
    return query ? '\u300c' + truncate(query, 50) + '\u300d' : '';
  }

  // agent.dispatch: show target agent
  if (toolName === 'agent.dispatch' || toolName === 'dispatch') {
    const p = parse(params ?? '');
    const target = typeof p.target_agent_id === 'string' ? p.target_agent_id.trim()
      : typeof p.targetAgentId === 'string' ? p.targetAgentId.trim()
      : '';
    return target ? '\u2192 ' + target : '';
  }

  // command.exec: show the command-hub token
  if (toolName === 'command.exec') {
    const p = parse(params ?? '');
    const raw = typeof p.input === 'string' ? p.input.trim() : '';
    if (!raw) return '';
    return truncate(raw, 90);
  }

  // write_stdin: show what is being written
  if (toolName === 'write_stdin') {
    const p = parse(params ?? '');
    const chars = typeof p.chars === 'string' ? p.chars.trim() : '';
    if (chars) {
      return '\u270d ' + truncate(chars, 80);
    }
    return '';
  }

  return '';
}

/**
 * Resolve a human-friendly display name for a tool call.
 * For shell.exec/exec_command, extract the actual command verb instead of showing "shell.exec".
 */
export function resolveToolDisplayName(toolName: string, input?: unknown): string {
  if (toolName === 'command.exec') {
    const raw = extractExecLikeCommand(input);
    if (!raw) return 'command.exec';
    const tokenMatch = raw.match(/<##\s*@?([^#>]+?)\s*##>/);
    if (tokenMatch && tokenMatch[1]) {
      return `cmd:${tokenMatch[1].trim()}`;
    }
    return `cmd:${raw.replace(/\s+/g, ' ').trim().slice(0, 40)}`;
  }

  if (['shell.exec', 'exec_command'].includes(toolName)) {
    const cmd = extractExecLikeCommand(input);
    const trimmed = cmd.trim();
    if (!trimmed) return toolName;
    // Extract primary command name (and subcommand for known command families)
    const m = trimmed.match(/^(\S+)(?:\s+(\S+))?/);
    if (m) {
      const verb = m[1];
      const sub = m[2] || '';
      if (['git', 'pnpm', 'npm', 'cargo', 'node', 'python'].includes(verb) && sub) {
        return `${verb} ${sub}`;
      }
      return verb;
    }
    return trimmed;
  }
  return toolName.replace(/^finger-system-agent-/, '');
}

/**
 * Build a dedup key from session progress state.
 */
export function buildReportKey(
  p: SessionProgressData,
  latestStepSummary: string | undefined,
): string {
  const recentTools = p.toolCallHistory
    .slice(-3)
    .map(t => `${t.toolName}:${classifyToolCall(t.toolName, t.params)}:${extractTargetFile(t.toolName, t.params)}:${t.success ?? ''}`)
    .join('|');
  return `${p.status}|${p.currentTask ?? ''}|${latestStepSummary ?? ''}|${recentTools}|${p.latestReasoning ?? ''}|${p.contextUsagePercent ?? ''}|${p.estimatedTokensInContextWindow ?? ''}|${p.maxInputTokens ?? ''}`;
}
