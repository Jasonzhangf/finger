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

function classifyExecCommand(command: string): ToolCategoryLabel {
  const normalized = command.trim().toLowerCase();
  if (normalized.length === 0) return '其他';

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
  return '其他';
}

export function resolveToolCategoryLabel(toolName: string, input?: unknown): ToolCategoryLabel {
  if (toolName === 'apply_patch') return '编辑';
  if (toolName === 'update_plan') return '计划';
  if (toolName.toLowerCase().includes('dispatch')) return '计划';
  if (toolName === 'context_ledger.memory') return '搜索';
  if (toolName === 'web_search') return '网络搜索';
  if (toolName === 'view_image') return '读取';
  if (toolName === 'write_stdin') return '写入';
  if (toolName === 'exec_command' || toolName === 'shell.exec') {
    const command = extractExecCommand(input);
    if (command) return classifyExecCommand(command);
    return '其他';
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
  if (command) return command;

  const normalizedInput = unwrapToolPayload(input);
  if (!isRecord(normalizedInput)) return undefined;

  if (toolName === 'write_stdin' && typeof normalizedInput.chars === 'string') {
    return `写入 ${normalizedInput.chars.length} 字符`;
  }

  if (typeof normalizedInput.path === 'string' && normalizedInput.path.trim().length > 0) {
    return `路径 ${truncateInlineText(normalizedInput.path, 120)}`;
  }

  const query = typeof normalizedInput.query === 'string'
    ? normalizedInput.query
    : typeof normalizedInput.q === 'string'
      ? normalizedInput.q
      : '';
  if (query.trim().length > 0) {
    return `查询 ${truncateInlineText(query, 120)}`;
  }

  if (typeof normalizedInput.action === 'string' && normalizedInput.action.trim().length > 0) {
    return `动作 ${truncateInlineText(normalizedInput.action, 80)}`;
  }

  return undefined;
}

export function resolveToolActionLabel(toolName: string, input?: unknown): string {
  const summary = buildToolExecutionSummary(toolName, input);
  if (summary && summary.trim().length > 0) return summary.trim();
  if (toolName === 'update_plan') return '更新计划';
  if (toolName === 'context_ledger.memory') return '查询记忆';
  if (toolName === 'web_search') return '网络搜索';
  if (toolName === 'apply_patch') return '应用补丁';
  if (toolName === 'view_image') return '查看图片';
  if (toolName === 'write_stdin') return '写入终端';
  if (toolName === 'exec_command') return '执行命令';
  return toolName;
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
  const actionLabel = resolveToolActionLabel(toolName, input);
  if (status === 'error') {
    return errorText ?? `执行失败：${actionLabel}${durationText}`;
  }
  return `执行成功：${actionLabel}${durationText}`;
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
