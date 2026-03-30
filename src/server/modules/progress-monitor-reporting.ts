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

  const truncateVerbatim = (text: string, max = 80): string => {
    const trimmed = text.trim();
    return trimmed.length > max ? trimmed.slice(0, max - 1) + '\u2026' : trimmed;
  };

  const humanizeMs = (ms: number): string => {
    if (!Number.isFinite(ms) || ms <= 0) return `${ms}ms`;
    if (ms % 3600000 === 0) return `${ms / 3600000}h`;
    if (ms % 60000 === 0) return `${ms / 60000}m`;
    if (ms % 1000 === 0) return `${ms / 1000}s`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`;
    return `${Math.floor(ms)}ms`;
  };

  const formatTypedInput = (text: string): string => {
    const visual = text
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t');
    return truncateVerbatim(visual, 100);
  };

  const detectSleepDuration = (rawCommand: string): string | undefined => {
    const match = rawCommand.match(/\bsleep\s+([0-9]*\.?[0-9]+)\s*([smhd]?)(?=\s|$|;|&&|\|\|)/i);
    if (!match) return undefined;
    const value = match[1];
    const unit = (match[2] || 's').toLowerCase();
    return `${value}${unit}`;
  };

  const unwrapShellWrapper = (raw: string): string => {
    const trimmed = raw.trim();
    const wrapped = trimmed.match(/^(?:\/bin\/)?(?:bash|sh|zsh)\s+-[a-zA-Z]+\s+(.+)$/);
    if (!wrapped || !wrapped[1]) return trimmed;
    const inner = wrapped[1].trim();
    const quote = inner[0];
    if ((quote === '"' || quote === '\'') && inner.endsWith(quote)) {
      return inner.slice(1, -1).trim();
    }
    return inner;
  };

  const extractReadablePath = (command: string): string => {
    const tokens = command.match(/[^\s|;'"<>]+/g) || [];
    for (let i = tokens.length - 1; i >= 0; i--) {
      const t = tokens[i];
      if (!t || t.startsWith('-')) continue;
      if (t === '&&' || t === '||') continue;
      if (t.includes('/') || /\.[a-zA-Z0-9]{1,8}$/.test(t)) return t;
    }
    return '';
  };

  const extractSearchPattern = (command: string): string => {
    const quoted = command.match(/["']([^"']{1,80})["']/);
    if (quoted && quoted[1]) return quoted[1].trim();
    const tokens = command.trim().split(/\s+/);
    if (tokens.length <= 1) return '';
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token || token.startsWith('-') || token.startsWith('/')) continue;
      if (token.includes('*') || token.includes('(') || token.includes(')')) continue;
      if (token.includes('/')) continue;
      return token.trim();
    }
    return '';
  };

  const describeExecCommand = (rawCommand: string): string => {
    const raw = unwrapShellWrapper(rawCommand);
    const lower = raw.toLowerCase();

    const sleepDuration = detectSleepDuration(raw);
    if (sleepDuration) return `\u23f1 sleep ${sleepDuration}`;

    const cdMatch = raw.match(/^\s*cd\s+(.+)$/i);
    if (cdMatch && cdMatch[1]) return `\ud83d\udcc1 切换目录 ${truncate(cdMatch[1].trim(), 60)}`;

    if (/^\s*tail\b/.test(lower) && (/\s-f(\s|$)/.test(lower) || /--follow\b/.test(lower))) {
      const path = extractReadablePath(raw);
      return path ? `\ud83d\udcdc 跟踪日志 ${truncate(path, 64)}` : '\ud83d\udcdc 跟踪日志输出';
    }

    if (/^\s*(cat|head|less|more)\b/.test(lower)) {
      const path = extractReadablePath(raw);
      return path ? `\ud83d\udcd6 读取 ${truncate(path, 64)}` : '\ud83d\udcd6 读取文件';
    }

    if (/^\s*tail\b/.test(lower)) {
      const path = extractReadablePath(raw);
      return path ? `\ud83d\udcd6 读取尾部 ${truncate(path, 64)}` : '\ud83d\udcd6 读取文件尾部';
    }

    if (/^\s*(rg|grep|ag)\b/.test(lower)) {
      const pattern = extractSearchPattern(raw);
      const path = extractReadablePath(raw);
      const patternPart = pattern ? `「${truncate(pattern, 36)}」` : '';
      if (path && patternPart) return `\ud83d\udd0d 搜索${patternPart} @ ${truncate(path, 40)}`;
      if (patternPart) return `\ud83d\udd0d 搜索${patternPart}`;
      if (path) return `\ud83d\udd0d 搜索 @ ${truncate(path, 40)}`;
      return '\ud83d\udd0d 搜索文本';
    }

    if (/^\s*find\b/.test(lower)) {
      const path = extractReadablePath(raw);
      const pattern = extractSearchPattern(raw);
      if (path && pattern) return `\ud83d\udd0d 查找 ${truncate(path, 40)} (${truncate(pattern, 28)})`;
      if (path) return `\ud83d\udd0d 查找 ${truncate(path, 40)}`;
      return '\ud83d\udd0d 查找文件';
    }

    if (/^\s*ls\b/.test(lower)) {
      const path = extractReadablePath(raw);
      return path ? `\ud83d\udcc2 列目录 ${truncate(path, 64)}` : '\ud83d\udcc2 列目录';
    }

    if (/^\s*wc\b/.test(lower)) {
      const path = extractReadablePath(raw);
      return path ? `\ud83d\udccf 统计 ${truncate(path, 64)}` : '\ud83d\udccf 统计内容';
    }

    if (/^\s*git\s+status\b/.test(lower)) return '\ud83e\udded 检查 Git 状态';
    if (/^\s*git\s+diff\b/.test(lower)) return '\ud83e\udded 查看 Git 差异';
    if (/^\s*(pnpm|npm|yarn)\s+test\b/.test(lower)) return '\ud83e\uddea 运行测试';
    if (/^\s*(pnpm|npm|yarn)\s+build\b/.test(lower)) return '\ud83d\udee0\ufe0f 执行构建';

    return truncate(raw, 90);
  };

  const readExecCommand = (payload: Record<string, unknown>): string => {
    const input = payload.input;
    if (typeof input === 'string' && input.trim().length > 0) return input.trim();
    if (typeof payload.cmd === 'string' && payload.cmd.trim().length > 0) return payload.cmd.trim();
    if (typeof payload.command === 'string' && payload.command.trim().length > 0) return payload.command.trim();
    if (Array.isArray(payload.command)) {
      const parts = payload.command.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
      if (parts.length > 0) return parts.join(' ').trim();
    }
    return '';
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
    const metadata = typeof p.metadata === 'object' && p.metadata !== null
      ? p.metadata as Record<string, unknown>
      : {};
    const taskId = typeof metadata.taskId === 'string' ? metadata.taskId.trim()
      : typeof p.task_id === 'string' ? p.task_id.trim()
      : typeof p.taskId === 'string' ? p.taskId.trim()
      : '';
    const source = typeof metadata.source === 'string' ? metadata.source.trim() : '';
    const targetPart = target ? '\u2192 ' + target : '';
    if (taskId.startsWith('watchdog:')) {
      const watchdogLabel = taskId
        .replace(/^watchdog:/, '')
        .replace(/:/g, ' · ');
      return [targetPart, `watchdog(${truncate(watchdogLabel, 48)})`].filter(Boolean).join(' ');
    }
    if (source === 'system-heartbeat' && taskId) {
      return [targetPart, `task=${truncate(taskId, 36)}`].filter(Boolean).join(' ');
    }
    return targetPart;
  }

  if (toolName === 'command.exec' || toolName === 'shell.exec' || toolName === 'exec_command') {
    const p = parse(params ?? '');
    const raw = readExecCommand(p);
    if (!raw) return '';
    return describeExecCommand(raw);
  }

  if (toolName === 'write_stdin') {
    const p = parse(params ?? '');
    const chars = typeof p.chars === 'string' ? p.chars : '';
    if (chars.trim().length > 0) {
      return '\u270d ' + formatTypedInput(chars);
    }
    const yieldMs = typeof p.yield_time_ms === 'number' && Number.isFinite(p.yield_time_ms)
      ? Math.max(0, Math.floor(p.yield_time_ms))
      : undefined;
    if (typeof yieldMs === 'number' && yieldMs > 0) {
      return `\u23f1 等待输出 ${humanizeMs(yieldMs)}`;
    }
    const maxOutputTokens = typeof p.max_output_tokens === 'number' && Number.isFinite(p.max_output_tokens)
      ? Math.max(0, Math.floor(p.max_output_tokens))
      : undefined;
    if (typeof maxOutputTokens === 'number' && maxOutputTokens > 0) {
      return `\u23f1 轮询输出 max=${maxOutputTokens}`;
    }
    if (typeof p.chars === 'string') {
      return '\u23f1 轮询输出';
    }
    return '';
  }

  if (toolName === 'report-task-completion') {
    const p = parse(params ?? '');
    const r = parse(result ?? '');
    const taskId = typeof p.task_id === 'string' ? p.task_id.trim()
      : typeof p.taskId === 'string' ? p.taskId.trim()
      : '';
    const dispatchId = typeof p.dispatch_id === 'string' ? p.dispatch_id.trim()
      : typeof p.dispatchId === 'string' ? p.dispatchId.trim()
      : '';
    const status = typeof p.status === 'string' ? p.status.trim()
      : typeof r.status === 'string' ? r.status.trim()
      : '';
    const summary = typeof p.summary === 'string' ? p.summary.trim()
      : typeof r.summary === 'string' ? r.summary.trim()
      : '';

    const details: string[] = [];
    if (taskId) details.push(`task=${truncate(taskId, 24)}`);
    if (dispatchId) details.push(`dispatch=${truncate(dispatchId, 24)}`);
    if (status) details.push(`status=${truncate(status, 18)}`);
    if (summary) details.push(truncate(summary, 40));
    return details.join(' · ');
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
