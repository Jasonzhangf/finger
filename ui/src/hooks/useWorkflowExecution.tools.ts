import type { ToolCategoryLabel } from './useWorkflowExecution.types.js';
import {
  firstStringField,
  isRecord,
  parseJsonObjectString,
  truncateInlineText,
} from './useWorkflowExecution.utils.js';

function looksLikeExecOutput(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.exitCode === 'number') return true;
  if (isRecord(value.termination) && typeof value.termination.type === 'string') return true;
  if (typeof value.wall_time_seconds === 'number') return true;
  if (typeof value.text === 'string' && value.text.includes('Process exited with code')) return true;
  return false;
}

function unwrapToolPayload(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (isRecord(value.input)) return value.input;
  if (isRecord(value.args)) return value.args;
  if (typeof value.arguments === 'string') {
    const parsed = parseJsonObjectString(value.arguments);
    if (parsed) return parsed;
  }
  return value;
}

export function normalizeToolName(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return 'unknown';
  if (
    normalized === 'shell'
    || normalized === 'shell.exec'
    || normalized === 'shell_command'
    || normalized === 'local_shell'
    || normalized === 'unified_exec'
  ) {
    return 'exec_command';
  }
  if (normalized === 'web_search_request') return 'web_search';
  return normalized;
}

function inferToolName(input?: unknown, output?: unknown): string | undefined {
  const normalizedInputRaw = unwrapToolPayload(input);
  const normalizedInput = typeof normalizedInputRaw === 'string'
    ? parseJsonObjectString(normalizedInputRaw) ?? normalizedInputRaw
    : normalizedInputRaw;
  if (isRecord(normalizedInput)) {
    if (typeof normalizedInput.cmd === 'string') return 'exec_command';
    if (typeof normalizedInput.command === 'string') return 'exec_command';
    if (Array.isArray(normalizedInput.command) && normalizedInput.command.length > 0) return 'exec_command';
    if (
      typeof normalizedInput.chars === 'string'
      && (typeof normalizedInput.session_id === 'string' || typeof normalizedInput.sessionId === 'string')
    ) {
      return 'write_stdin';
    }
    if (typeof normalizedInput.path === 'string') return 'view_image';
    if (typeof normalizedInput.query === 'string' || typeof normalizedInput.q === 'string') return 'web_search';
    if (typeof normalizedInput.action === 'string' && normalizedInput.action === 'query') return 'context_ledger.memory';
  }

  const normalizedOutputRaw = unwrapToolPayload(output);
  const normalizedOutput = typeof normalizedOutputRaw === 'string'
    ? parseJsonObjectString(normalizedOutputRaw) ?? normalizedOutputRaw
    : normalizedOutputRaw;
  if (isRecord(normalizedOutput)) {
    if (Array.isArray(normalizedOutput.plan)) return 'update_plan';
    if (
      typeof normalizedOutput.path === 'string'
      && typeof normalizedOutput.mimeType === 'string'
      && normalizedOutput.mimeType.startsWith('image/')
    ) {
      return 'view_image';
    }
    if (Array.isArray(normalizedOutput.results)) return 'web_search';
    if (looksLikeExecOutput(normalizedOutput)) return 'exec_command';
    if (isRecord(normalizedOutput.result)) {
      if (looksLikeExecOutput(normalizedOutput.result)) return 'exec_command';
      if (
        typeof normalizedOutput.result.path === 'string'
        && typeof normalizedOutput.result.mimeType === 'string'
        && normalizedOutput.result.mimeType.startsWith('image/')
      ) {
        return 'view_image';
      }
    }
  }

  return undefined;
}

export function resolveDisplayToolName(payload: Record<string, unknown>, input?: unknown, output?: unknown): string {
  const explicitName = firstStringField(payload, ['toolName', 'tool_name', 'tool']);
  if (explicitName) {
    const normalized = normalizeToolName(explicitName);
    if (normalized !== 'unknown') return normalized;
  }
  return inferToolName(input, output) ?? 'unknown';
}

type ToolResultVerb = 'search' | 'read' | 'write' | 'run' | 'edit' | 'plan' | 'other';

function splitCommandHead(command: string): string {
  return command.split(/(?:\|\||&&|\||;)/)[0]?.trim() ?? command.trim();
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null = regex.exec(command);
  while (match) {
    const token = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (token.length > 0) tokens.push(token);
    match = regex.exec(command);
  }
  return tokens;
}

function looksLikePathToken(token: string): boolean {
  if (!token || token.startsWith('-')) return false;
  if (token.startsWith('~') || token.startsWith('/') || token.startsWith('./') || token.startsWith('../')) return true;
  if (/^[A-Za-z]:[\\/]/.test(token)) return true;
  if (/[\\/]/.test(token)) return true;
  return /\.[A-Za-z0-9_-]{1,8}$/.test(token);
}

function pickFilenameFromToken(token: string): string {
  const normalized = token.trim().replace(/\\/g, '/');
  const compact = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  const parts = compact.split('/').filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? token;
}

function parseExecCommandTarget(command: string, category: ToolCategoryLabel): string | undefined {
  const head = splitCommandHead(command);
  const tokens = tokenizeCommand(head);
  if (tokens.length <= 1) return undefined;
  const executable = tokens[0].toLowerCase();
  const args = tokens.slice(1);

  if ((executable === 'cp' || executable === 'mv') && args.length >= 2) {
    const last = [...args].reverse().find((token) => looksLikePathToken(token) && token !== '.');
    return last ? pickFilenameFromToken(last) : undefined;
  }

  if (executable === 'find') {
    const target = args.find((token) => looksLikePathToken(token) && !token.startsWith('-'));
    return target ? pickFilenameFromToken(target) : undefined;
  }

  if (executable === 'rg' || executable === 'grep') {
    const candidates = args.filter((token) => looksLikePathToken(token) && !token.startsWith('-'));
    const target = candidates[candidates.length - 1];
    return target ? pickFilenameFromToken(target) : undefined;
  }

  const pathToken = args.find((token) => looksLikePathToken(token) && token !== '.');
  if (pathToken) return pickFilenameFromToken(pathToken);
  if (category === '运行') return executable;
  return undefined;
}

function parseApplyPatchTarget(input: unknown): string | undefined {
  const normalizedInput = unwrapToolPayload(input);
  const patchText = typeof normalizedInput === 'string'
    ? normalizedInput
    : (isRecord(normalizedInput) && typeof normalizedInput.patch === 'string'
      ? normalizedInput.patch
      : '');
  if (patchText.trim().length === 0) return undefined;
  const matches = Array.from(
    patchText.matchAll(/^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+)$/gm),
  ).map((item) => item[1]?.trim()).filter((item): item is string => Boolean(item));
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return pickFilenameFromToken(matches[0]);
  return `${pickFilenameFromToken(matches[0])} +${matches.length - 1}`;
}

function parseMailboxAction(toolName: string): string {
  const normalized = toolName.trim().toLowerCase();
  if (!normalized.startsWith('mailbox.')) return '';
  return normalized.slice('mailbox.'.length);
}

function parseContextLedgerAction(input: unknown): string {
  const normalizedInput = unwrapToolPayload(input);
  if (!isRecord(normalizedInput)) return '';
  if (typeof normalizedInput.action === 'string') return normalizedInput.action.trim().toLowerCase();
  return '';
}

function parseQueryLabel(input: unknown): string | undefined {
  const normalizedInput = unwrapToolPayload(input);
  if (!isRecord(normalizedInput)) return undefined;
  const query = typeof normalizedInput.query === 'string'
    ? normalizedInput.query.trim()
    : typeof normalizedInput.q === 'string'
      ? normalizedInput.q.trim()
      : '';
  return query.length > 0 ? truncateInlineText(query, 48) : undefined;
}

function classifyExecCommand(command: string): ToolCategoryLabel {
  const normalized = command.trim().toLowerCase();
  if (normalized.length === 0) return '运行';

  if (/(^|\s)(rg|grep|find|fd)\b/.test(normalized)) return '搜索';
  if (/(^|\s)(cat|sed|head|tail|less|more|ls|pwd|stat|wc|du|git\s+(show|status|log|diff))\b/.test(normalized)) {
    return '读取';
  }
  if (
    /(^|\s)(echo|tee|cp|mv|rm|mkdir|rmdir|touch|chmod|chown|git\s+(add|commit|checkout|restore)|npm\s+install|pnpm\s+install|yarn\s+add)\b/.test(normalized)
    || />\s*[^ ]/.test(normalized)
  ) {
    return '写入';
  }
  return '运行';
}

function normalizeToolVerb(category: ToolCategoryLabel): ToolResultVerb {
  if (category === '搜索' || category === '网络搜索') return 'search';
  if (category === '读取') return 'read';
  if (category === '写入') return 'write';
  if (category === '运行') return 'run';
  if (category === '编辑') return 'edit';
  if (category === '计划') return 'plan';
  return 'other';
}

export function resolveToolCategoryLabel(toolName: string, input?: unknown): ToolCategoryLabel {
  if (toolName === 'apply_patch') return '编辑';
  if (toolName === 'update_plan') return '计划';
  if (toolName.toLowerCase().includes('dispatch')) return '计划';
  if (toolName === 'context_ledger.memory') {
    const action = parseContextLedgerAction(input);
    if (action === 'index' || action === 'compact' || action === 'write') return '写入';
    if (action === 'query' || action === 'search' || action === 'read') return '读取';
    return '搜索';
  }
  if (toolName === 'web_search') return '网络搜索';
  if (toolName === 'view_image') return '读取';
  if (toolName === 'write_stdin') return '运行';
  if (toolName.toLowerCase().startsWith('mailbox.')) {
    const action = parseMailboxAction(toolName);
    if (action === 'ack' || action === 'remove' || action === 'remove_all') return '写入';
    return '读取';
  }
  if (toolName === 'exec_command' || toolName === 'shell.exec') {
    const command = extractExecCommand(input);
    if (command) return classifyExecCommand(command);
    return '运行';
  }
  return '其他';
}

function formatCommandArray(command: unknown[]): string {
  return command
    .filter((item): item is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof item))
    .map((item) => String(item))
    .join(' ')
    .trim();
}

export function extractExecCommand(input: unknown): string | undefined {
  const normalizedInput = unwrapToolPayload(input);
  if (!isRecord(normalizedInput)) return undefined;
  if (typeof normalizedInput.cmd === 'string' && normalizedInput.cmd.trim().length > 0) {
    return truncateInlineText(normalizedInput.cmd, 200);
  }
  if (typeof normalizedInput.command === 'string' && normalizedInput.command.trim().length > 0) {
    return truncateInlineText(normalizedInput.command, 200);
  }
  if (Array.isArray(normalizedInput.command)) {
    const formatted = formatCommandArray(normalizedInput.command);
    if (formatted.length > 0) return truncateInlineText(formatted, 200);
  }
  return undefined;
}

function buildToolExecutionSummary(toolName: string, input?: unknown): string | undefined {
  const command = extractExecCommand(input);
  if (command) {
    const category = classifyExecCommand(command);
    const target = parseExecCommandTarget(command, category);
    if (target) return target;
    return truncateInlineText(command, 72);
  }

  if (toolName === 'apply_patch') {
    const patchTarget = parseApplyPatchTarget(input);
    if (patchTarget) return patchTarget;
  }

  const normalizedInput = unwrapToolPayload(input);
  if (!isRecord(normalizedInput)) return undefined;

  if (toolName === 'write_stdin' && typeof normalizedInput.chars === 'string') {
    return `stdin(${normalizedInput.chars.length} chars)`;
  }

  if (toolName.toLowerCase().startsWith('mailbox.')) {
    const action = parseMailboxAction(toolName) || 'status';
    const id = typeof normalizedInput.id === 'string' ? normalizedInput.id.trim() : '';
    const category = typeof normalizedInput.category === 'string' ? normalizedInput.category.trim() : '';
    if (id.length > 0) return `${action} ${truncateInlineText(id, 36)}`;
    if (category.length > 0) return `${action} ${truncateInlineText(category, 24)}`;
    return action;
  }

  if (toolName === 'context_ledger.memory') {
    const action = parseContextLedgerAction(input) || 'query';
    const query = parseQueryLabel(input);
    if (query) return `${action} ${query}`;
    return action;
  }

  if (typeof normalizedInput.path === 'string' && normalizedInput.path.trim().length > 0) {
    return pickFilenameFromToken(normalizedInput.path);
  }

  const query = typeof normalizedInput.query === 'string'
    ? normalizedInput.query
    : typeof normalizedInput.q === 'string'
      ? normalizedInput.q
      : '';
  if (query.trim().length > 0) {
    return truncateInlineText(query, 60);
  }

  if (typeof normalizedInput.action === 'string' && normalizedInput.action.trim().length > 0) {
    return truncateInlineText(normalizedInput.action, 80);
  }

  return undefined;
}

export function resolveToolActionLabel(toolName: string, input?: unknown): string {
  const summary = buildToolExecutionSummary(toolName, input);
  if (summary && summary.trim().length > 0) return summary.trim();
  if (toolName === 'update_plan') return 'plan updated';
  if (toolName === 'context_ledger.memory') return 'ledger query';
  if (toolName === 'web_search') return 'search';
  if (toolName === 'apply_patch') return 'edit files';
  if (toolName === 'view_image') return 'read image';
  if (toolName === 'write_stdin') return 'run stdin';
  if (toolName === 'exec_command') return 'run command';
  if (toolName.startsWith('mailbox.')) return `mailbox ${toolName.slice('mailbox.'.length)}`;
  return `run ${toolName}`;
}

function stringifyToolPayload(value: unknown, maxChars = 260): string | undefined {
  if (value === null || value === undefined) return undefined;
  let raw = '';
  if (typeof value === 'string') {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value, null, 2);
    } catch {
      raw = String(value);
    }
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...` : trimmed;
}

function cleanTechnicalErrorText(raw: string): string {
  const normalized = raw
    .replace(/tool execution failed for [^:]+:\s*/ig, '')
    .replace(/\b(ENOENT|EACCES|ETIMEDOUT|ECONNREFUSED|EPIPE)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0 ? normalized : '执行失败';
}

export function humanizeToolError(toolName: string, rawError: unknown): string {
  const text = typeof rawError === 'string' ? rawError.trim() : '';
  if (text.length === 0) return `工具执行失败：${toolName}`;

  const spawnMissing = text.match(/spawn\s+([^\s]+)\s+enoent/i);
  if (spawnMissing) {
    return `工具执行失败：未找到可执行命令 ${spawnMissing[1]}`;
  }

  const lower = text.toLowerCase();
  if (lower.includes('permission denied') || lower.includes('eacces')) {
    return '工具执行失败：权限不足，当前环境不允许该操作';
  }
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('etimedout')) {
    return '工具执行失败：执行超时，请缩小范围后重试';
  }
  if (lower.includes('not found') || lower.includes('no such file') || lower.includes('enoent')) {
    return '工具执行失败：目标命令或文件不存在';
  }

  return `工具执行失败：${cleanTechnicalErrorText(text)}`;
}

export function extractToolFailureText(output: unknown): string | undefined {
  if (typeof output === 'string' && output.trim().length > 0) {
    return output.trim();
  }
  if (!isRecord(output)) return undefined;

  if (typeof output.error === 'string' && output.error.trim().length > 0) {
    return output.error.trim();
  }
  if (isRecord(output.result)) {
    const nested = output.result;
    if (typeof nested.error === 'string' && nested.error.trim().length > 0) {
      return nested.error.trim();
    }
    if (typeof nested.stderr === 'string' && nested.stderr.trim().length > 0) {
      return nested.stderr.trim();
    }
  }
  if (typeof output.stderr === 'string' && output.stderr.trim().length > 0) {
    return output.stderr.trim();
  }

  return undefined;
}

export function resolveToolResultStatus(output: unknown): 'success' | 'error' {
  if (!isRecord(output)) return 'success';
  if (typeof output.ok === 'boolean') return output.ok ? 'success' : 'error';
  if (typeof output.success === 'boolean') return output.success ? 'success' : 'error';
  if (typeof output.exitCode === 'number') return output.exitCode === 0 ? 'success' : 'error';

  if (isRecord(output.result)) {
    const result = output.result;
    if (typeof result.ok === 'boolean') return result.ok ? 'success' : 'error';
    if (typeof result.success === 'boolean') return result.success ? 'success' : 'error';
    if (typeof result.exitCode === 'number') return result.exitCode === 0 ? 'success' : 'error';
  }

  return 'success';
}

export function buildHumanToolResultOutput(toolName: string, output: unknown): string | undefined {
  if (
    toolName !== 'shell.exec'
    && toolName !== 'exec_command'
    && toolName !== 'write_stdin'
    && toolName !== 'shell'
    && toolName !== 'shell_command'
  ) {
    return stringifyToolPayload(output, 1200);
  }

  if (!isRecord(output)) return stringifyToolPayload(output, 1200);
  const result = isRecord(output.result) ? output.result : output;
  const stdout = typeof result.stdout === 'string'
    ? result.stdout
    : typeof result.output === 'string'
      ? result.output
      : typeof result.text === 'string'
        ? result.text
        : '';
  const stderr = typeof result.stderr === 'string' ? cleanTechnicalErrorText(result.stderr) : '';

  const parts: string[] = [];
  if (stdout.trim().length > 0) {
    parts.push(`输出:\n${stdout.trim().slice(0, 2000)}`);
  }
  if (stderr.trim().length > 0) {
    parts.push(`提示:\n${stderr.trim().slice(0, 800)}`);
  }
  if (parts.length === 0) {
    return '命令已执行，无可展示输出。';
  }
  return parts.join('\n\n');
}

export function buildToolResultContent(
  toolName: string,
  status: 'success' | 'error',
  duration?: number,
  errorText?: string,
  input?: unknown,
): string {
  const durationText = typeof duration === 'number' ? ` (${duration}ms)` : '';
  const category = resolveToolCategoryLabel(toolName, input);
  const verb = normalizeToolVerb(category);
  const actionLabel = resolveToolActionLabel(toolName, input);
  const base = `[${verb}] ${actionLabel}`;
  if (status === 'error') {
    if (errorText && errorText.trim().length > 0) {
      return `${base} · failed${durationText} · ${errorText.trim()}`;
    }
    return `${base} · failed${durationText}`;
  }
  return `${base} · success${durationText}`;
}

export function isGenericToolStatusContent(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (normalized.length === 0) return true;
  return normalized.startsWith('工具调用:')
    || normalized.startsWith('工具完成:')
    || normalized.startsWith('工具失败:')
    || normalized.startsWith('tool_call:')
    || normalized.startsWith('tool_result:')
    || normalized.startsWith('tool_error:');
}

export function normalizeToolNameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map(normalizeToolName);
  return Array.from(new Set(names));
}
