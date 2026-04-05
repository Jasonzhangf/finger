import {
  buildContextUsageLine,
  classifyToolCall,
  extractTargetFile,
  type SessionProgressData,
} from './progress-monitor-utils.js';
import type { ContextBreakdownSnapshot } from './progress-monitor-types.js';
import {
  foldToolLines,
  type FoldableToolLineItem,
} from './progress-monitor-reporting-helpers.js';
import {
  extractToolDetail,
  resolveToolDisplayName,
} from './progress-monitor-tool-detail.js';
export { resolveToolDisplayName } from './progress-monitor-tool-detail.js';

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

function resolveContextUsageFromBreakdown(params: {
  breakdown?: ContextBreakdownSnapshot;
  maxInputTokens?: number;
}): string | undefined {
  const { breakdown, maxInputTokens } = params;
  if (!breakdown) return undefined;
  const historyContext = typeof breakdown.historyContextTokens === 'number' && Number.isFinite(breakdown.historyContextTokens)
    ? Math.max(0, Math.floor(breakdown.historyContextTokens))
    : undefined;
  const historyCurrent = typeof breakdown.historyCurrentTokens === 'number' && Number.isFinite(breakdown.historyCurrentTokens)
    ? Math.max(0, Math.floor(breakdown.historyCurrentTokens))
    : undefined;
  const historyTotal = typeof breakdown.historyTotalTokens === 'number' && Number.isFinite(breakdown.historyTotalTokens)
    ? Math.max(0, Math.floor(breakdown.historyTotalTokens))
    : (
      historyContext !== undefined || historyCurrent !== undefined
        ? (historyContext ?? 0) + (historyCurrent ?? 0)
        : undefined
    );
  if (historyTotal === undefined) return undefined;
  return buildContextUsageLine({
    estimatedTokensInContextWindow: historyTotal,
    maxInputTokens,
  });
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
    const fallbackContextLine = resolveContextUsageFromBreakdown({
      breakdown: p.contextBreakdown,
      maxInputTokens: p.maxInputTokens,
    });
    if (fallbackContextLine) {
      lines.push(`${fallbackContextLine} · 来自历史快照`);
    } else {
      lines.push('🧠 上下文: 当前为工具流，尚未收到本轮 model_round 统计（并非无上下文）');
    }
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

export function buildReportKey(p: SessionProgressData, latestStepSummary: string | undefined): string {
  const recentTools = selectRecentToolsWithPriority(p.toolCallHistory, 3)
    .map((t) => `${t.toolName}:${classifyToolCall(t.toolName, t.params)}:${extractTargetFile(t.toolName, t.params)}:${t.success ?? ''}`)
    .join('|');
  const breakdownKey = p.contextBreakdown
    ? JSON.stringify(p.contextBreakdown)
    : '';
  return `${p.status}|${p.currentTask ?? ''}|${latestStepSummary ?? ''}|${recentTools}|${p.latestReasoning ?? ''}|${p.contextUsagePercent ?? ''}|${p.estimatedTokensInContextWindow ?? ''}|${p.maxInputTokens ?? ''}|${p.lastContextEvent ?? ''}|${p.contextBreakdownMode ?? ''}|${breakdownKey}|${(p.controlTags ?? []).join(',')}|${(p.controlHookNames ?? []).join(',')}|${typeof p.controlBlockValid === 'boolean' ? String(p.controlBlockValid) : ''}|${(p.controlIssues ?? []).join(',')}`;
}
