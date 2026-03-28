import {
  buildContextUsageLine,
  classifyToolCall,
  extractTargetFile,
  type SessionProgressData,
} from './progress-monitor-utils.js';

export interface BuildCompactSummaryOptions {
  includeTask?: boolean;
  includeReasoning?: boolean;
  headerMode?: 'full' | 'minimal';
}

/**
 * Build a compact, mobile-readable progress summary for one session.
 */
export function buildCompactSummary(
  p: SessionProgressData,
  formatElapsed: (ms: number) => string,
  options?: BuildCompactSummaryOptions,
): string {
  const includeTask = options?.includeTask ?? true;
  const includeReasoning = options?.includeReasoning ?? true;
  const headerMode = options?.headerMode ?? 'full';
  void formatElapsed;
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

  const contextLine = buildContextUsageLine({
    contextUsagePercent: p.contextUsagePercent,
    estimatedTokensInContextWindow: p.estimatedTokensInContextWindow,
    maxInputTokens: p.maxInputTokens,
  });
  if (contextLine) {
    lines.push(contextLine);
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

  if (toolName === 'update_plan') {
    const p = parse(params ?? '');
    const planItems = Array.isArray(p.plan) ? p.plan as Array<Record<string, unknown>> : [];
    if (planItems.length === 0) return '';
    const inProgress = planItems.find((item) => item.status === 'in_progress');
    if (inProgress && typeof inProgress.step === 'string') {
      return '\u25b6 ' + truncate(inProgress.step, 80);
    }
    for (let i = planItems.length - 1; i >= 0; i--) {
      const step = planItems[i];
      if (typeof step.step === 'string') {
        const statusIcon = step.status === 'completed' ? '\u2713' : step.status === 'in_progress' ? '\u25b6' : '\u25cb';
        return statusIcon + ' ' + truncate(step.step, 60);
      }
    }
    return '';
  }

  if (toolName === 'web_search' || toolName === 'search_query') {
    const p = parse(params ?? '');
    const query = typeof p.query === 'string' ? p.query.trim()
      : typeof p.q === 'string' ? p.q.trim()
      : '';
    return query ? '\u300c' + truncate(query, 50) + '\u300d' : '';
  }

  if (toolName === 'agent.dispatch' || toolName === 'dispatch') {
    const p = parse(params ?? '');
    const target = typeof p.target_agent_id === 'string' ? p.target_agent_id.trim()
      : typeof p.targetAgentId === 'string' ? p.targetAgentId.trim()
      : '';
    return target ? '\u2192 ' + target : '';
  }

  if (toolName === 'command.exec') {
    const p = parse(params ?? '');
    const raw = typeof p.input === 'string' ? p.input.trim() : '';
    if (!raw) return '';
    return truncate(raw, 90);
  }

  if (toolName === 'write_stdin') {
    const p = parse(params ?? '');
    const chars = typeof p.chars === 'string' ? p.chars.trim() : '';
    if (chars) {
      return '\u270d ' + truncate(chars, 80);
    }
    return '';
  }

  if (toolName === 'view_image') {
    const p = parse(params ?? '');
    const path = typeof p.path === 'string' ? p.path.trim() : '';
    return path ? '\ud83d\uddbc ' + truncate(path, 80) : '';
  }

  if (toolName === 'context_ledger.memory') {
    const p = parse(params ?? '');
    const action = typeof p.action === 'string' ? p.action.trim() : '';
    const query = typeof p.query === 'string' ? p.query.trim() : '';
    if (action && query) return `${action}: ${truncate(query, 50)}`;
    if (action) return action;
    return '';
  }

  if (toolName === 'context_builder.rebuild') {
    const p = parse(params ?? '');
    const mode = typeof p.mode === 'string' ? p.mode.trim() : '';
    return mode ? `mode=${mode}` : '';
  }

  if (toolName === 'agent.deploy') {
    const p = parse(params ?? '');
    const id = typeof p.agentId === 'string' ? p.agentId.trim() : '';
    const role = typeof p.roleProfile === 'string' ? p.roleProfile.trim() : '';
    if (id && role) return `${id} (${role})`;
    return id || role || '';
  }

  if (toolName === 'agent.capabilities') {
    const p = parse(params ?? '');
    const id = typeof p.agentId === 'string' ? p.agentId.trim() : '';
    return id ? `agent=${id}` : '';
  }

  if (toolName === 'agent.control') {
    const p = parse(params ?? '');
    const action = typeof p.action === 'string' ? p.action.trim() : '';
    const id = typeof p.agentId === 'string' ? p.agentId.trim() : '';
    if (action && id) return `${action} ${id}`;
    return action || id || '';
  }

  if (toolName === 'agent.list') {
    const p = parse(params ?? '');
    const status = typeof p.status === 'string' ? p.status.trim() : '';
    return status ? `status=${status}` : '';
  }

  if (/^mailbox\./.test(toolName)) {
    const p = parse(params ?? '');
    const id = typeof p.message_id === 'string' ? p.message_id.trim() : '';
    return id ? `id=${id}` : '';
  }

  if (/^skills\./.test(toolName)) {
    const p = parse(params ?? '');
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    return name ? `name=${name}` : '';
  }

  return '';
}

/**
 * Resolve a human-friendly display name for a tool call.
 * For shell.exec/exec_command, extract the actual command verb instead of showing "shell.exec".
 */
export function resolveToolDisplayName(toolName: string, input?: unknown): string {
  const extractExecLikeCommand = (payloadInput?: unknown): string => {
    let payload: Record<string, unknown> = {};
    if (typeof payloadInput === 'string') {
      try {
        const parsed = JSON.parse(payloadInput);
        if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
      } catch {
        payload = { cmd: payloadInput };
      }
    } else if (typeof payloadInput === 'object' && payloadInput !== null) {
      payload = payloadInput as Record<string, unknown>;
    }

    if (typeof payload.cmd === 'string' && payload.cmd.trim().length > 0) return payload.cmd.trim();
    const command = payload.command;
    if (typeof command === 'string' && command.trim().length > 0) return command.trim();
    if (Array.isArray(command)) {
      const parts = command.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
      if (parts.length > 0) return parts.join(' ').trim();
    }
    if (typeof payload.input === 'string' && payload.input.trim().length > 0) return payload.input.trim();
    return '';
  };

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
