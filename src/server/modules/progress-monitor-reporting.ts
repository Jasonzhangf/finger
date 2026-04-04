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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
      const detail = extractToolDetail(t.toolName, t.params, t.result, t.error);
      const filePart = file ? ` | ${file}` : '';
      const detailPart = detail ? ` ${detail}` : '';
      const line = `${icon} [${cat}] ${resolvedName}${filePart}${detailPart}`;
      return { icon, cat, resolvedName, file, detail, line };
    });
    lines.push(foldToolLines(toolItems).join('\n'));
  }

  return lines.join('\n');
}

function extractToolDetail(toolName: string, params?: string, result?: string, error?: string): string {
  if (!params && !result && !error) return '';
  const p = parsePayload(params ?? '');
  const r = parsePayload(result ?? '');

  const pickString = (...values: unknown[]): string => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
    return '';
  };

  const pickNumber = (...values: unknown[]): number | null => {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return null;
  };

  const extractNestedErrorText = (value: unknown): string => {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (!value || typeof value !== 'object') return '';
    const obj = value as Record<string, unknown>;
    const direct = pickString(obj.error, obj.message, obj.reason, obj.detail, obj.details);
    if (direct) return direct;
    const nested = isObjectRecord(obj.error) ? extractNestedErrorText(obj.error) : '';
    if (nested) return nested;
    return '';
  };

  const parsedErrorText = pickString(
    error,
    r.error,
    r.message,
    r.reason,
    extractNestedErrorText(r.details),
    extractNestedErrorText(r.metadata),
  );

  const attachError = (baseDetail: string): string => {
    const normalized = baseDetail.trim();
    if (!parsedErrorText) return normalized;
    const errorPart = `错误=${truncateInline(parsedErrorText, 140)}`;
    if (!normalized) return errorPart;
    if (/\b(错误=|error=|错误:|error:)/i.test(normalized)) return normalized;
    return `${normalized} · ${errorPart}`;
  };

  if (toolName === 'update_plan') {
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
    return attachError(`计划共 ${planItems.length} 项：${lines.join('')}`);
  }

  if (toolName === 'web_search' || toolName === 'search_query') {
    const query = typeof p.query === 'string' ? p.query.trim() : typeof p.q === 'string' ? p.q.trim() : '';
    return attachError(query ? '\u300c' + truncateInline(query, 50) + '\u300d' : '');
  }

  if (toolName === 'agent.dispatch' || toolName === 'dispatch') {
    const target = typeof p.target_agent_id === 'string' ? p.target_agent_id.trim()
      : typeof p.targetAgentId === 'string' ? p.targetAgentId.trim() : '';
    const assignment = typeof p.assignment === 'object' && p.assignment !== null
      ? p.assignment as Record<string, unknown>
      : {};
    const metadata = typeof p.metadata === 'object' && p.metadata !== null
      ? p.metadata as Record<string, unknown>
      : {};
    const resultDetails = typeof r.details === 'object' && r.details !== null
      ? r.details as Record<string, unknown>
      : {};
    const resultMetadata = typeof r.metadata === 'object' && r.metadata !== null
      ? r.metadata as Record<string, unknown>
      : {};

    const taskId = pickString(metadata.taskId, p.task_id, p.taskId, resultDetails.taskId, resultDetails.task_id);
    const dispatchId = pickString(r.dispatchId, r.dispatch_id, resultDetails.dispatchId, resultDetails.dispatch_id);
    const taskName = pickString(
      assignment.taskName,
      p.task_name,
      p.taskName,
      resultDetails.taskName,
      resultDetails.task_name,
    );
    const taskText = pickString(p.task, assignment.task, resultDetails.task, r.summary);
    const source = pickString(metadata.source, resultMetadata.source, resultDetails.source);
    const projectPath = pickString(
      p.projectPath,
      p.project_path,
      assignment.projectPath,
      assignment.project_path,
      metadata.projectPath,
      metadata.project_path,
      resultDetails.projectPath,
      resultDetails.project_path,
    );
    const assigner = pickString(
      p.source_agent_id,
      p.sourceAgentId,
      metadata.assigner,
      metadata.sourceAgentName,
      resultDetails.assigner,
    );
    const details: string[] = [];
    if (target) details.push(`\u2192 ${target}`);
    if (assigner) details.push(`from=${truncateInline(assigner, 24)}`);
    if (dispatchId) details.push(`dispatch=${truncateInline(dispatchId, 28)}`);
    if (projectPath) details.push(`prj=${truncateInline(projectPath, 34)}`);
    if (taskId.startsWith('watchdog:')) {
      const watchdogLabel = taskId.replace(/^watchdog:/, '').replace(/:/g, ' · ');
      details.push(`watchdog(${truncateInline(watchdogLabel, 48)})`);
      return attachError(details.join(' '));
    }
    if (source === 'system-heartbeat' && taskId) {
      details.push(`task=${truncateInline(taskId, 36)}`);
      if (taskName) details.push(`name=${truncateInline(taskName, 48)}`);
      return attachError(details.join(' · '));
    }
    if (taskId) details.push(`task=${truncateInline(taskId, 42)}`);
    if (taskName) details.push(`name=${truncateInline(taskName, 64)}`);
    if (taskText) details.push(`内容=${truncateInline(taskText, 140)}`);
    return attachError(details.join(' · '));
  }

  if (toolName === 'agent.query' || toolName === 'agent.progress.ask') {
    const target = pickString(p.target_agent_id, p.targetAgentId, p.agentId, p.agent_id);
    const query = pickString(p.query, p.task, p.prompt);
    const projectPath = pickString(p.projectPath, p.project_path);
    const details: string[] = [];
    if (target) details.push(`→ ${target}`);
    if (projectPath) details.push(`prj=${truncateInline(projectPath, 34)}`);
    if (query) details.push(truncateInline(query, 72));
    return attachError(details.join(' · '));
  }

  if (toolName === 'command.exec' || toolName === 'shell.exec' || toolName === 'exec_command') {
    const raw = readExecCommand(p);
    return attachError(raw ? describeExecCommand(raw) : '');
  }

  if (toolName === 'write_stdin') return attachError(formatWriteStdinDetail(p));

  if (toolName === 'report-task-completion') {
    const taskId = typeof p.task_id === 'string' ? p.task_id.trim() : typeof p.taskId === 'string' ? p.taskId.trim() : '';
    const dispatchId = typeof p.dispatch_id === 'string' ? p.dispatch_id.trim() : typeof p.dispatchId === 'string' ? p.dispatchId.trim() : '';
    const status = typeof p.status === 'string' ? p.status.trim() : typeof r.status === 'string' ? r.status.trim() : '';
    const summary = typeof p.summary === 'string' ? p.summary.trim() : typeof r.summary === 'string' ? r.summary.trim() : '';
    const details: string[] = [];
    if (taskId) details.push(`task=${truncateInline(taskId, 24)}`);
    if (dispatchId) details.push(`dispatch=${truncateInline(dispatchId, 24)}`);
    if (status) details.push(`status=${truncateInline(status, 18)}`);
    if (summary) details.push(truncateInline(summary, 40));
    return attachError(details.join(' · '));
  }

  if (toolName === 'view_image') {
    const path = pickString(p.path);
    return attachError(path ? '\ud83d\uddbc ' + truncateInline(path, 80) : '');
  }

  if (toolName === 'context_ledger.memory') {
    const action = typeof p.action === 'string' ? p.action.trim() : '';
    const query = typeof p.query === 'string' ? p.query.trim() : '';
    if (action && query) return attachError(`${action}: ${truncateInline(query, 50)}`);
    return attachError(action);
  }

  if (toolName === 'context_builder.rebuild') {
    const mode = pickString(p.mode);
    return attachError(mode ? `mode=${mode}` : '');
  }

  if (toolName === 'agent.deploy') {
    const id = pickString(p.agentId, p.agent_id, r.agentId);
    const role = pickString(p.roleProfile, p.role_profile, r.roleProfile);
    if (id && role) return attachError(`${id} (${role})`);
    return attachError(id || role || '');
  }

  if (toolName === 'agent.capabilities') {
    const id = pickString(p.agentId, p.agent_id);
    return attachError(id ? `agent=${id}` : '');
  }

  if (toolName === 'agent.control') {
    const action = pickString(p.action, p.command);
    const id = pickString(p.agentId, p.agent_id);
    if (action && id) return attachError(`${action} ${id}`);
    return attachError(action || id || '');
  }

  if (toolName === 'agent.list') {
    const status = pickString(p.status, p.state);
    const count = pickNumber(r.count, r.total, p.count, p.total);
    const details: string[] = [];
    if (status) details.push(`status=${status}`);
    if (typeof count === 'number') details.push(`count=${Math.max(0, Math.floor(count))}`);
    return attachError(details.join(' · '));
  }

  if (toolName === 'project.task.status' || toolName === 'project.task.update') {
    const action = pickString(p.action, p.status);
    const taskId = pickString(p.taskId, p.task_id, p.id, r.taskId, r.task_id);
    const projectPath = pickString(p.projectPath, p.project_path, r.projectPath, r.project_path);
    const owner = pickString(p.owner, p.assignee, r.owner, r.assignee);
    const status = pickString(r.status, p.status);
    const summary = pickString(p.summary, r.summary, p.note, r.note);
    const details: string[] = [];
    if (action) details.push(`action=${truncateInline(action, 18)}`);
    if (taskId) details.push(`task=${truncateInline(taskId, 28)}`);
    if (owner) details.push(`owner=${truncateInline(owner, 20)}`);
    if (projectPath) details.push(`prj=${truncateInline(projectPath, 34)}`);
    if (status) details.push(`status=${truncateInline(status, 14)}`);
    if (summary) details.push(truncateInline(summary, 48));
    return attachError(details.join(' · '));
  }

  if (/^mailbox\./.test(toolName)) {
    const id = pickString(p.message_id, p.id, p.messageId, r.id, r.message_id);
    const target = pickString(p.target, p.agentId, p.agent_id, r.target);
    const category = pickString(p.category, p.source);
    const unread = pickNumber(r.unread, r.unreadCount, r.unread_count);
    const pending = pickNumber(r.pending, r.pendingCount, r.pending_count);
    const total = pickNumber(r.total, r.count, r.total_count);
    const status = pickString(r.status, p.status);
    const details: string[] = [];
    if (target) details.push(`→ ${truncateInline(target, 24)}`);
    if (id) details.push(`id=${truncateInline(id, 26)}`);
    if (category) details.push(`cat=${truncateInline(category, 16)}`);
    if (typeof total === 'number') details.push(`total=${Math.max(0, Math.floor(total))}`);
    if (typeof unread === 'number') details.push(`unread=${Math.max(0, Math.floor(unread))}`);
    if (typeof pending === 'number') details.push(`pending=${Math.max(0, Math.floor(pending))}`);
    if (status) details.push(`status=${truncateInline(status, 12)}`);
    return attachError(details.join(' · '));
  }

  if (/^skills\./.test(toolName)) {
    const name = pickString(p.name);
    return attachError(name ? `name=${name}` : '');
  }

  return attachError('');
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
