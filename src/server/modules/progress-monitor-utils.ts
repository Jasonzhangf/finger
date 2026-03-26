/**
 * Progress Monitor - Tool Classification & File Extraction Utilities
 *
 * Extracted from progress-monitor.ts to keep file under 500 lines.
 */

export type ToolCategory = '读写' | '搜索' | '工具' | '其他';

/**
 * Classify a tool call into a human-readable category.
 */
export function classifyToolCall(toolName: string, input?: unknown): ToolCategory {
  // 搜索类优先
  if (['web_search', 'web_search_results'].includes(toolName)) return '搜索';

  if (['shell.exec', 'exec_command'].includes(toolName)) {
    const cmd = (() => {
      if (typeof input === 'string') {
        try {
          const parsed = JSON.parse(input) as { cmd?: unknown };
          if (parsed && typeof parsed.cmd === 'string') return parsed.cmd;
        } catch { /* ignore */ }
        return input;
      }
      if (typeof input === 'object' && input !== null && 'cmd' in input) {
        return String((input as { cmd: unknown }).cmd);
      }
      return '';
    })();
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

  if (/^(agent\.|context_ledger|memsearch|update_plan|clock\.|user\.|bd\b)/.test(toolName)) return '工具';

  return '其他';
}

/**
 * Extract a meaningful file/dir name from tool input.
 */
export function extractTargetFile(toolName: string, input?: unknown): string {
  const obj: Record<string, unknown> = (() => {
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
  })();

  if (Object.keys(obj).length === 0) return '';

  if (toolName === 'apply_patch' && obj.patch) {
    const m = String(obj.patch).match(/^--- a\/(\S+)/m);
    return m ? m[1] : '';
  }

  if ('cmd' in obj) {
    const cmd = String(obj.cmd);
    const m = cmd.match(/\s+([\w./~][\w./\-]+\.\w{1,6})/);
    return m ? m[1] : '';
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
  const elapsed = formatElapsed(p.elapsedMs);
  const task = p.currentTask || '';
  const recentTools = p.toolCallHistory.slice(-5);

  const lines: string[] = [];
  if (headerMode === 'minimal') {
    lines.push(`📊 ${p.agentId} | ${elapsed}`);
  } else {
    lines.push(`📊 ${p.agentId} | ${elapsed} | ${task || '执行中'}`);
  }

  if (includeTask && task) {
    lines.push(`🧭 ${task}`);
  }

  if (includeReasoning && p.latestReasoning) {
    lines.push(`💭 ${p.latestReasoning}`);
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
 * Currently handles: update_plan, web_search, agent.dispatch.
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

  return '';
}

/**
 * Resolve a human-friendly display name for a tool call.
 * For shell.exec/exec_command, extract the actual command verb instead of showing "shell.exec".
 */
export function resolveToolDisplayName(toolName: string, input?: unknown): string {
  if (['shell.exec', 'exec_command'].includes(toolName)) {
    const cmd = (() => {
      if (typeof input === 'string') {
        try {
          const parsed = JSON.parse(input) as { cmd?: unknown };
          if (parsed && typeof parsed.cmd === 'string') return parsed.cmd;
        } catch { /* ignore */ }
        return input;
      }
      if (typeof input === 'object' && input !== null && 'cmd' in input) {
        return String((input as { cmd: unknown }).cmd);
      }
      return '';
    })();
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
  return `${p.status}|${p.currentTask ?? ''}|${latestStepSummary ?? ''}|${recentTools}|${p.latestReasoning ?? ''}`;
}
