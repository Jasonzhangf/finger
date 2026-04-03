import {
  buildContextUsageLine,
  classifyToolCall,
  extractTargetFile,
  type SessionProgressData,
} from './progress-monitor-utils.js';
import type { ContextBreakdownSnapshot } from './progress-monitor-types.js';
import {
  describeExecCommand,
  foldToolLines,
  formatWriteStdinDetail,
  type FoldableToolLineItem,
} from './progress-monitor-reporting-helpers.js';

export interface BuildCompactSummaryOptions {
  includeTask?: boolean;
  includeReasoning?: boolean;
  headerMode?: 'full' | 'minimal';
}

type ToolHistoryEntry = SessionProgressData['toolCallHistory'][number];

function selectRecentToolsWithPriority(
  history: ToolHistoryEntry[],
  baseWindow: number,
  prioritizedTools: string[] = ['update_plan', 'report-task-completion'],
): ToolHistoryEntry[] {
  if (!Array.isArray(history) || history.length === 0) return [];
  const start = Math.max(0, history.length - Math.max(1, baseWindow));
  const selectedIndexes = new Set<number>();
  for (let i = start; i < history.length; i += 1) {
    selectedIndexes.add(i);
  }
  for (const toolName of prioritizedTools) {
    let index = -1;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i].toolName === toolName) {
        index = i;
        break;
      }
    }
    if (index >= 0) selectedIndexes.add(index);
  }
  return Array.from(selectedIndexes)
    .sort((a, b) => a - b)
    .map((idx) => history[idx]);
}

function parsePayload(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return typeof obj === 'object' && obj !== null ? obj as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function truncateInline(text: string, max = 60): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '\u2026' : trimmed;
}

function compactList(values: string[] | undefined, maxItems = 8, maxLen = 180): string {
  if (!Array.isArray(values) || values.length === 0) return '';
  const items = values
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, Math.max(1, maxItems));
  if (items.length === 0) return '';
  return truncateInline(items.join(','), maxLen);
}

function compactToken(value?: number): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  if (value >= 1000) {
    const compact = (value / 1000).toFixed(value >= 100000 ? 0 : 1);
    return `${compact.replace(/\.0$/, '')}k`;
  }
  return `${Math.floor(value)}`;
}

function shareLabel(tokens: number | undefined, maxInputTokens: number | undefined): string {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return '?';
  if (typeof maxInputTokens === 'number' && Number.isFinite(maxInputTokens) && maxInputTokens > 0) {
    const ratio = Math.max(0, (tokens / maxInputTokens) * 100);
    const pct = ratio < 0.1 && tokens > 0 ? '<0.1%' : `${ratio.toFixed(1).replace(/\.0$/, '')}%`;
    return `${compactToken(tokens)}(${pct})`;
  }
  return compactToken(tokens) ?? '?';
}

function buildContextBreakdownLines(
  breakdown: ContextBreakdownSnapshot | undefined,
  mode: 'release' | 'dev' | undefined,
  maxInputTokens: number | undefined,
  estimatedContextTokens: number | undefined,
): string[] {
  if (!breakdown) {
    return ['🧩 构成统计: 等待模型回传模块占用'];
  }
  const lines: string[] = [];
  const historyContext = shareLabel(breakdown?.historyContextTokens, maxInputTokens);
  const historyCurrent = shareLabel(breakdown?.historyCurrentTokens, maxInputTokens);
  const systemPrompt = shareLabel(breakdown?.systemPromptTokens, maxInputTokens);
  const developerPrompt = shareLabel(breakdown?.developerPromptTokens, maxInputTokens);
  const userInstructions = shareLabel(breakdown?.userInstructionsTokens, maxInputTokens);
  const environmentContext = shareLabel(breakdown?.environmentContextTokens, maxInputTokens);
  const turnContext = shareLabel(breakdown?.turnContextTokens, maxInputTokens);
  const skills = shareLabel(breakdown?.skillsTokens, maxInputTokens);
  const mailbox = shareLabel(breakdown?.mailboxTokens, maxInputTokens);
  const project = shareLabel(breakdown?.projectTokens, maxInputTokens);
  const flow = shareLabel(breakdown?.flowTokens, maxInputTokens);
  const contextSlots = shareLabel(breakdown?.contextSlotsTokens, maxInputTokens);
  const inputText = shareLabel(breakdown?.inputTextTokens, maxInputTokens);
  const inputMedia = shareLabel(breakdown?.inputMediaTokens, maxInputTokens);
  const inputMediaCount = typeof breakdown?.inputMediaCount === 'number' && Number.isFinite(breakdown.inputMediaCount)
    ? Math.max(0, Math.floor(breakdown.inputMediaCount))
    : undefined;
  const inputMediaItems = inputMediaCount !== undefined ? `${inputMediaCount} item${inputMediaCount === 1 ? '' : 's'}` : '?';
  const inputTotal = shareLabel(
    typeof breakdown?.inputTotalTokens === 'number'
      ? breakdown.inputTotalTokens
      : (typeof breakdown?.inputTextTokens === 'number' || typeof breakdown?.inputMediaTokens === 'number')
        ? (breakdown.inputTextTokens ?? 0) + (breakdown.inputMediaTokens ?? 0)
        : undefined,
    maxInputTokens,
  );
  const toolsSchema = shareLabel(breakdown?.toolsSchemaTokens, maxInputTokens);
  const toolExecution = shareLabel(breakdown?.toolExecutionTokens, maxInputTokens);
  const contextLedger = shareLabel(breakdown?.contextLedgerConfigTokens, maxInputTokens);
  const responsesConfig = shareLabel(breakdown?.responsesConfigTokens, maxInputTokens);
  const trackedTokensRaw = typeof breakdown?.totalKnownTokens === 'number' && Number.isFinite(breakdown.totalKnownTokens)
    ? Math.max(0, Math.floor(breakdown.totalKnownTokens))
    : undefined;
  const trackedTotal = shareLabel(trackedTokensRaw, maxInputTokens);
  const allUnknown = [
    historyContext,
    historyCurrent,
    systemPrompt,
    developerPrompt,
    userInstructions,
    environmentContext,
    turnContext,
    skills,
    mailbox,
    project,
    flow,
    contextSlots,
    inputText,
    inputMedia,
    inputTotal,
    inputMediaItems,
    toolsSchema,
    toolExecution,
    contextLedger,
    responsesConfig,
    trackedTotal,
  ]
    .every((value) => value === '?');
  if (allUnknown) {
    return ['🧩 构成统计: 等待模型回传模块占用'];
  }
  if (mode !== 'dev') {
    lines.push(
      `🧩 构成: H(c=${historyContext},cur=${historyCurrent}) · P(sys=${systemPrompt},dev=${developerPrompt}) · C(sk=${skills},mb=${mailbox},prj=${project},flow=${flow},slot=${contextSlots})`,
    );
    lines.push(
      `🧩 构成: I(text=${inputText},media=${inputMedia}) · T(schema=${toolsSchema},exec=${toolExecution},ledger=${contextLedger}) · Σ=${trackedTotal}`,
    );
    return lines;
  }
  lines.push(`🧩 构成: H(c=${historyContext},cur=${historyCurrent}) · P(sys=${systemPrompt},dev=${developerPrompt})`);
  lines.push(`🧩 构成: C(sk=${skills},mb=${mailbox},prj=${project},flow=${flow},slot=${contextSlots})`);
  lines.push(`🧩 构成: I(total=${inputTotal},text=${inputText},media=${inputMedia}/${inputMediaItems}) · T(schema=${toolsSchema},exec=${toolExecution},ledger=${contextLedger},resp=${responsesConfig})`);
  lines.push(`🧩 构成: E(env=${environmentContext},turn=${turnContext},userInst=${userInstructions}) · Σ=${trackedTotal}`);
  return lines;
}

function resolveEstimatedContextTokens(
  contextUsagePercent: number | undefined,
  estimatedTokensInContextWindow: number | undefined,
  maxInputTokens: number | undefined,
): number | undefined {
  if (typeof estimatedTokensInContextWindow === 'number' && Number.isFinite(estimatedTokensInContextWindow) && estimatedTokensInContextWindow >= 0) {
    return Math.floor(estimatedTokensInContextWindow);
  }
  if (
    typeof contextUsagePercent === 'number'
    && Number.isFinite(contextUsagePercent)
    && contextUsagePercent >= 0
    && typeof maxInputTokens === 'number'
    && Number.isFinite(maxInputTokens)
    && maxInputTokens > 0
  ) {
    return Math.max(0, Math.floor((contextUsagePercent / 100) * maxInputTokens));
  }
  return undefined;
}

function readExecCommand(payload: Record<string, unknown>): string {
  const input = payload.input;
  if (typeof input === 'string' && input.trim().length > 0) return input.trim();
  if (typeof payload.cmd === 'string' && payload.cmd.trim().length > 0) return payload.cmd.trim();
  if (typeof payload.command === 'string' && payload.command.trim().length > 0) return payload.command.trim();
  if (Array.isArray(payload.command)) {
    const parts = payload.command.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    if (parts.length > 0) return parts.join(' ').trim();
  }
  return '';
}

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
  const recentTools = selectRecentToolsWithPriority(p.toolCallHistory, 5);

  const lines: string[] = [];
  lines.push(headerMode === 'minimal'
    ? `📊 ${localTime} | ${p.status === 'running' ? '执行中' : p.status}`
    : `📊 ${localTime} | ${task || '执行中'}`);

  if (includeTask && task) lines.push(`🧭 ${task}`);
  if (includeReasoning && p.latestReasoning) lines.push(`💭 ${p.latestReasoning}`);

  const contextLine = buildContextUsageLine({
    contextUsagePercent: p.contextUsagePercent,
    estimatedTokensInContextWindow: p.estimatedTokensInContextWindow,
    maxInputTokens: p.maxInputTokens,
  });
  if (contextLine) {
    lines.push(contextLine);
  } else {
    lines.push('🧠 上下文: 当前为工具流，尚未收到本轮 model_round 统计（并非无上下文）');
  }
  const estimatedContextTokens = resolveEstimatedContextTokens(
    p.contextUsagePercent,
    p.estimatedTokensInContextWindow,
    p.maxInputTokens,
  );
  lines.push(...buildContextBreakdownLines(
    p.contextBreakdown,
    p.contextBreakdownMode,
    p.maxInputTokens,
    estimatedContextTokens,
  ));
  if (p.lastContextEvent && p.lastContextEvent.trim().length > 0) {
    lines.push(`♻️ ${truncateInline(p.lastContextEvent, 120)}`);
  }
  if (p.contextBreakdownMode === 'dev') {
    const tags = compactList(p.controlTags, 10, 180);
    const hooks = compactList(p.controlHookNames, 10, 180);
    const issues = compactList(p.controlIssues, 6, 180);
    if (tags || hooks || issues || typeof p.controlBlockValid === 'boolean') {
      lines.push(
        `🏷 控制: tags=${tags || '-'} · hooks=${hooks || '-'} · valid=${typeof p.controlBlockValid === 'boolean' ? String(p.controlBlockValid) : '?'}${issues ? ` · issues=${issues}` : ''}`,
      );
    }
  }

  if (recentTools.length > 0) {
    const toolItems: FoldableToolLineItem[] = recentTools.map((t) => {
      const icon = t.success === false ? '❌' : t.success === true ? '✅' : '⏳';
      const cat = classifyToolCall(t.toolName, t.params);
      const resolvedName = resolveToolDisplayName(t.toolName, t.params);
      const file = extractTargetFile(t.toolName, t.params);
      const detail = extractToolDetail(t.toolName, t.params, t.result);
      const filePart = file ? ` | ${file}` : '';
      const detailPart = detail ? ` ${detail}` : '';
      const line = `${icon} [${cat}] ${resolvedName}${filePart}${detailPart}`;
      return { icon, cat, resolvedName, file, detail, line };
    });
    lines.push(foldToolLines(toolItems).join('\n'));
  }

  return lines.join('\n');
}

function extractToolDetail(toolName: string, params?: string, result?: string): string {
  if (!params && !result) return '';

  if (toolName === 'update_plan') {
    const p = parsePayload(params ?? '');
    const planItems = Array.isArray(p.plan) ? p.plan as Array<Record<string, unknown>> : [];
    if (planItems.length === 0) return '';
    const lines = planItems.map((item) => {
      const step = typeof item.step === 'string' ? item.step.trim() : '';
      if (!step) return '';
      const status = typeof item.status === 'string' ? item.status.trim() : '';
      const statusIcon = status === 'completed'
        ? '\u2713'
        : status === 'in_progress'
          ? '\u25b6'
          : '\u25cb';
      // Jason 要求：update_plan 不做截断，保持完整可读。
      return `\n   ${statusIcon} ${step}`;
    }).filter((item) => item.length > 0);
    if (lines.length === 0) return '';
    return `计划共 ${planItems.length} 项：${lines.join('')}`;
  }

  if (toolName === 'web_search' || toolName === 'search_query') {
    const p = parsePayload(params ?? '');
    const query = typeof p.query === 'string' ? p.query.trim() : typeof p.q === 'string' ? p.q.trim() : '';
    return query ? '\u300c' + truncateInline(query, 50) + '\u300d' : '';
  }

  if (toolName === 'agent.dispatch' || toolName === 'dispatch') {
    const p = parsePayload(params ?? '');
    const target = typeof p.target_agent_id === 'string' ? p.target_agent_id.trim()
      : typeof p.targetAgentId === 'string' ? p.targetAgentId.trim() : '';
    const assignment = typeof p.assignment === 'object' && p.assignment !== null
      ? p.assignment as Record<string, unknown>
      : {};
    const metadata = typeof p.metadata === 'object' && p.metadata !== null ? p.metadata as Record<string, unknown> : {};
    const taskId = typeof metadata.taskId === 'string' ? metadata.taskId.trim()
      : typeof p.task_id === 'string' ? p.task_id.trim()
      : typeof p.taskId === 'string' ? p.taskId.trim() : '';
    const taskName = typeof assignment.taskName === 'string'
      ? assignment.taskName.trim()
      : typeof p.task_name === 'string'
        ? p.task_name.trim()
        : typeof p.taskName === 'string'
          ? p.taskName.trim()
          : '';
    const taskText = typeof p.task === 'string' ? p.task.trim() : '';
    const source = typeof metadata.source === 'string' ? metadata.source.trim() : '';
    const details: string[] = [];
    if (target) details.push(`\u2192 ${target}`);
    if (taskId.startsWith('watchdog:')) {
      const watchdogLabel = taskId.replace(/^watchdog:/, '').replace(/:/g, ' · ');
      details.push(`watchdog(${truncateInline(watchdogLabel, 48)})`);
      return details.join(' ');
    }
    if (source === 'system-heartbeat' && taskId) {
      details.push(`task=${truncateInline(taskId, 36)}`);
      if (taskName) details.push(`name=${truncateInline(taskName, 48)}`);
      return details.join(' · ');
    }
    if (taskId) details.push(`task=${truncateInline(taskId, 42)}`);
    if (taskName) details.push(`name=${truncateInline(taskName, 64)}`);
    if (taskText) details.push(`内容=${truncateInline(taskText, 140)}`);
    return details.join(' · ');
  }

  if (toolName === 'command.exec' || toolName === 'shell.exec' || toolName === 'exec_command') {
    const raw = readExecCommand(parsePayload(params ?? ''));
    return raw ? describeExecCommand(raw) : '';
  }

  if (toolName === 'write_stdin') return formatWriteStdinDetail(parsePayload(params ?? ''));

  if (toolName === 'report-task-completion') {
    const p = parsePayload(params ?? '');
    const r = parsePayload(result ?? '');
    const taskId = typeof p.task_id === 'string' ? p.task_id.trim() : typeof p.taskId === 'string' ? p.taskId.trim() : '';
    const dispatchId = typeof p.dispatch_id === 'string' ? p.dispatch_id.trim() : typeof p.dispatchId === 'string' ? p.dispatchId.trim() : '';
    const status = typeof p.status === 'string' ? p.status.trim() : typeof r.status === 'string' ? r.status.trim() : '';
    const summary = typeof p.summary === 'string' ? p.summary.trim() : typeof r.summary === 'string' ? r.summary.trim() : '';
    const details: string[] = [];
    if (taskId) details.push(`task=${truncateInline(taskId, 24)}`);
    if (dispatchId) details.push(`dispatch=${truncateInline(dispatchId, 24)}`);
    if (status) details.push(`status=${truncateInline(status, 18)}`);
    if (summary) details.push(truncateInline(summary, 40));
    return details.join(' · ');
  }

  if (toolName === 'view_image') {
    const path = typeof parsePayload(params ?? '').path === 'string' ? String(parsePayload(params ?? '').path).trim() : '';
    return path ? '\ud83d\uddbc ' + truncateInline(path, 80) : '';
  }

  if (toolName === 'context_ledger.memory') {
    const p = parsePayload(params ?? '');
    const action = typeof p.action === 'string' ? p.action.trim() : '';
    const query = typeof p.query === 'string' ? p.query.trim() : '';
    if (action && query) return `${action}: ${truncateInline(query, 50)}`;
    return action;
  }

  if (toolName === 'context_builder.rebuild') {
    const mode = typeof parsePayload(params ?? '').mode === 'string' ? String(parsePayload(params ?? '').mode).trim() : '';
    return mode ? `mode=${mode}` : '';
  }

  if (toolName === 'agent.deploy') {
    const p = parsePayload(params ?? '');
    const id = typeof p.agentId === 'string' ? p.agentId.trim() : '';
    const role = typeof p.roleProfile === 'string' ? p.roleProfile.trim() : '';
    if (id && role) return `${id} (${role})`;
    return id || role || '';
  }

  if (toolName === 'agent.capabilities') {
    const id = typeof parsePayload(params ?? '').agentId === 'string' ? String(parsePayload(params ?? '').agentId).trim() : '';
    return id ? `agent=${id}` : '';
  }

  if (toolName === 'agent.control') {
    const p = parsePayload(params ?? '');
    const action = typeof p.action === 'string' ? p.action.trim() : '';
    const id = typeof p.agentId === 'string' ? p.agentId.trim() : '';
    if (action && id) return `${action} ${id}`;
    return action || id || '';
  }

  if (toolName === 'agent.list') {
    const status = typeof parsePayload(params ?? '').status === 'string' ? String(parsePayload(params ?? '').status).trim() : '';
    return status ? `status=${status}` : '';
  }

  if (/^mailbox\./.test(toolName)) {
    const id = typeof parsePayload(params ?? '').message_id === 'string' ? String(parsePayload(params ?? '').message_id).trim() : '';
    return id ? `id=${id}` : '';
  }

  if (/^skills\./.test(toolName)) {
    const name = typeof parsePayload(params ?? '').name === 'string' ? String(parsePayload(params ?? '').name).trim() : '';
    return name ? `name=${name}` : '';
  }

  return '';
}

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
    if (tokenMatch && tokenMatch[1]) return `cmd:${tokenMatch[1].trim()}`;
    const m = raw.match(/^(\S+)(?:\s+(\S+))?/);
    if (!m) return 'command.exec';
    const verb = m[1];
    const sub = m[2] || '';
    if (['git', 'pnpm', 'npm', 'cargo', 'node', 'python', 'python3'].includes(verb) && sub) return `${verb} ${sub}`;
    return verb;
  }

  if (toolName === 'shell.exec' || toolName === 'exec_command') {
    const cmd = extractExecLikeCommand(input).trim();
    if (!cmd) return toolName;
    const m = cmd.match(/^(\S+)(?:\s+(\S+))?/);
    if (!m) return cmd;
    const verb = m[1];
    const sub = m[2] || '';
    if (['git', 'pnpm', 'npm', 'cargo', 'node', 'python'].includes(verb) && sub) return `${verb} ${sub}`;
    return verb;
  }

  return toolName.replace(/^finger-system-agent-/, '');
}

export function buildReportKey(p: SessionProgressData, latestStepSummary: string | undefined): string {
  const recentTools = selectRecentToolsWithPriority(p.toolCallHistory, 3)
    .map((t) => `${t.toolName}:${classifyToolCall(t.toolName, t.params)}:${extractTargetFile(t.toolName, t.params)}:${t.success ?? ''}`)
    .join('|');
  const breakdownKey = p.contextBreakdown
    ? JSON.stringify(p.contextBreakdown)
    : '';
  return `${p.status}|${p.currentTask ?? ''}|${latestStepSummary ?? ''}|${recentTools}|${p.latestReasoning ?? ''}|${p.contextUsagePercent ?? ''}|${p.estimatedTokensInContextWindow ?? ''}|${p.maxInputTokens ?? ''}|${p.lastContextEvent ?? ''}|${p.contextBreakdownMode ?? ''}|${breakdownKey}|${(p.controlTags ?? []).join(',')}|${(p.controlHookNames ?? []).join(',')}|${typeof p.controlBlockValid === 'boolean' ? String(p.controlBlockValid) : ''}|${(p.controlIssues ?? []).join(',')}`;
}
