import { heartbeatMailbox } from './heartbeat-mailbox.js';
import type { PushSettings } from '../../bridges/types.js';
import type { SessionEnvelopeMapping } from './agent-status-subscriber-types.js';

export type ToolVerb = 'search' | 'read' | 'write' | 'run' | 'edit' | 'plan' | 'other';

const RAW_TOOL_ERROR_SUPPRESSED_CHANNELS = new Set(['qqbot', 'openclaw-weixin']);

export function shouldSuppressRawToolError(channelId?: string): boolean {
  if (!channelId) return false;
  return RAW_TOOL_ERROR_SUPPRESSED_CHANNELS.has(channelId);
}

export function truncateInline(value: string, max = 72): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function resolveOutputRecord(output: unknown): Record<string, unknown> | null {
  if (!output || typeof output !== 'object') return null;
  const record = output as Record<string, unknown>;
  if (record.result && typeof record.result === 'object' && record.result !== null) {
    return record.result as Record<string, unknown>;
  }
  return record;
}

function extractStdout(output: unknown): string | undefined {
  const record = resolveOutputRecord(output);
  if (!record) return undefined;
  const stdout = typeof record.stdout === 'string'
    ? record.stdout
    : typeof record.output === 'string'
      ? record.output
      : typeof record.text === 'string'
        ? record.text
        : '';
  const normalized = stdout.trim();
  return normalized.length > 0 ? truncateInline(normalized, 100) : undefined;
}

function extractStderr(output: unknown): string | undefined {
  const record = resolveOutputRecord(output);
  if (!record) return undefined;
  const stderr = typeof record.stderr === 'string'
    ? record.stderr
    : typeof record.error === 'string'
      ? record.error
      : '';
  const normalized = stderr.trim();
  return normalized.length > 0 ? truncateInline(normalized, 100) : undefined;
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

function pickFileName(token: string): string {
  const normalized = token.trim().replace(/\\/g, '/');
  const compact = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  const parts = compact.split('/').filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? token;
}

function classifyExecCommand(command: string): ToolVerb {
  const normalized = command.trim().toLowerCase();
  if (normalized.length === 0) return 'run';
  if (/(^|\s)(rg|grep|find|fd)\b/.test(normalized)) return 'search';
  if (/(^|\s)(cat|sed|head|tail|less|more|ls|pwd|stat|wc|du|git\s+(show|status|log|diff))\b/.test(normalized)) return 'read';
  if (/(^|\s)(echo|tee|cp|mv|rm|mkdir|rmdir|touch|chmod|chown|git\s+(add|commit|checkout|restore)|npm\s+install|pnpm\s+install|yarn\s+add)\b/.test(normalized) || />\s*[^ ]/.test(normalized)) {
    return 'write';
  }
  return 'run';
}

function parseExecCommandTarget(command: string, verb: ToolVerb): string | undefined {
  const firstSegment = command.split(/(?:\|\||&&|\||;)/)[0]?.trim() ?? command.trim();
  const tokens = tokenizeCommand(firstSegment);
  if (tokens.length <= 1) return undefined;
  const executable = tokens[0].toLowerCase();
  const args = tokens.slice(1);

  if ((executable === 'cp' || executable === 'mv') && args.length >= 2) {
    const last = [...args].reverse().find((token) => looksLikePathToken(token) && token !== '.');
    return last ? pickFileName(last) : undefined;
  }

  if (executable === 'find') {
    const path = args.find((token) => looksLikePathToken(token));
    return path ? pickFileName(path) : undefined;
  }

  if (executable === 'rg' || executable === 'grep') {
    const candidates = args.filter((token) => looksLikePathToken(token) && !token.startsWith('-'));
    const target = candidates[candidates.length - 1];
    return target ? pickFileName(target) : undefined;
  }

  const candidate = args.find((token) => looksLikePathToken(token) && token !== '.');
  if (candidate) return pickFileName(candidate);
  if (verb === 'run') return executable;
  return undefined;
}

function parseMailboxVerb(toolName: string): ToolVerb {
  const action = toolName.replace(/^mailbox\./i, '').toLowerCase();
  if (action === 'ack' || action === 'remove' || action === 'remove_all') return 'write';
  return 'read';
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

export function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isMailboxDispatchStatus(status: string): boolean {
  return status.toLowerCase().includes('mailbox');
}

function extractMailboxEnvelopeSummary(targetAgentId: string, mailboxMessageId: string): string {
  const mailboxMessage = heartbeatMailbox.get(targetAgentId, mailboxMessageId);
  if (!mailboxMessage) return '';
  const content = asRecord(mailboxMessage.content);
  const envelope = asRecord(content?.envelope);
  const title = asTrimmedString(envelope?.title);
  const shortDescription = asTrimmedString(envelope?.shortDescription);
  if (title && shortDescription) {
    return `${truncateInline(title, 36)} - ${truncateInline(shortDescription, 72)}`;
  }
  if (title) return truncateInline(title, 100);
  if (shortDescription) return truncateInline(shortDescription, 100);
  return '';
}

function sanitizeDispatchMailboxText(text: string, mailboxMessageId: string): string {
  let sanitized = text;
  if (mailboxMessageId) {
    sanitized = sanitized.split(mailboxMessageId).join('').replace(/\(\s*\)/g, '');
  }
  sanitized = sanitized
    .replace(/ROBOT[0-9.]*_[A-Za-z0-9._\-!]+/gi, '')
    .replace(/\bmsg-[a-z0-9-]{8,}\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return truncateInline(sanitized, 100);
}

export function buildDispatchMailboxPreview(params: {
  targetAgentId: string;
  mailboxMessageId: string;
  resultSummary: string;
  nextAction: string;
}): string {
  if (params.mailboxMessageId) {
    const envelopeSummary = extractMailboxEnvelopeSummary(params.targetAgentId, params.mailboxMessageId);
    if (envelopeSummary) return envelopeSummary;
  }

  if (params.resultSummary) {
    const sanitized = sanitizeDispatchMailboxText(params.resultSummary, params.mailboxMessageId);
    if (sanitized) return sanitized;
  }

  if (params.nextAction) {
    const sanitized = sanitizeDispatchMailboxText(params.nextAction, params.mailboxMessageId);
    if (sanitized) return sanitized;
  }

  return '已转入待处理队列';
}

export function parseToolSummary(toolName: string, input: unknown, output?: unknown): {
  verb: ToolVerb;
  target?: string;
  signals?: string[];
  details?: Record<string, unknown>;
} {
  const normalizedToolName = typeof toolName === 'string' ? toolName.trim().toLowerCase() : 'unknown';
  const payload = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  if (normalizedToolName === 'apply_patch') {
    const patchText = typeof payload.patch === 'string'
      ? payload.patch
      : typeof input === 'string'
        ? input
        : '';
    const match = patchText.match(/^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+)$/m);
    return {
      verb: 'edit',
      ...(match && match[1] ? { target: pickFileName(match[1]) } : {}),
    };
  }

  if (normalizedToolName === 'update_plan') {
    const outputRecord = resolveOutputRecord(output);
    const explanation = outputRecord && typeof outputRecord.explanation === 'string' ? outputRecord.explanation.trim() : '';
    const planItems = outputRecord && Array.isArray(outputRecord.plan) ? outputRecord.plan : [];

    const completedCount = planItems.filter((p: any) => p.status === 'completed').length;
    const totalCount = planItems.length;
    const inProgressItem = planItems.find((p: any) => p.status === 'in_progress');
    const pendingItems = planItems.filter((p: any) => p.status === 'pending').slice(0, 2);

    const statusParts: string[] = [];
    if (totalCount > 0) {
      statusParts.push(`${completedCount}/${totalCount}`);
    }
    if (inProgressItem) {
      statusParts.push(`当前: ${(inProgressItem as any).step}`);
    } else if (pendingItems.length > 0) {
      statusParts.push(`下一步: ${(pendingItems[0] as any).step}`);
    }
    const statusText = statusParts.length > 0 ? statusParts.join(' | ') : '';

    return {
      verb: 'plan',
      signals: [
        explanation ? `说明: ${truncateInline(explanation, 80)}` : '',
        statusText ? `进度: ${statusText}` : '',
      ].filter((item) => item.length > 0),
    };
  }

  if (normalizedToolName === 'context_ledger.memory') {
    const action = typeof payload.action === 'string' ? payload.action.trim().toLowerCase() : 'query';
    const query = typeof payload.query === 'string' ? payload.query.trim() : '';
    const outputRecord = resolveOutputRecord(output);
    const summary = outputRecord && typeof outputRecord.summary === 'string' ? outputRecord.summary.trim() : '';
    const hits = outputRecord && Array.isArray(outputRecord.results) ? outputRecord.results.length : undefined;
    const verb: ToolVerb = (action === 'index' || action === 'compact' || action === 'write') ? 'write' : 'read';
    return {
      verb,
      ...(query.length > 0 ? { target: truncateInline(query, 48) } : {}),
      signals: [
        `action=${action}`,
        query.length > 0 ? `query=${truncateInline(query, 100)}` : '',
        typeof hits === 'number' ? `hits=${hits}` : '',
        summary.length > 0 ? `summary=${truncateInline(summary, 100)}` : '',
      ].filter((item) => item.length > 0),
    };
  }

  if (normalizedToolName.startsWith('mailbox.')) {
    const id = typeof payload.id === 'string' ? payload.id.trim() : '';
    const outputRecord = resolveOutputRecord(output);
    const message = outputRecord && outputRecord.message && typeof outputRecord.message === 'object'
      ? outputRecord.message as Record<string, unknown>
      : null;
    const counts = outputRecord && outputRecord.counts && typeof outputRecord.counts === 'object'
      ? outputRecord.counts as Record<string, unknown>
      : null;
    const recentUnread = outputRecord && Array.isArray(outputRecord.recentUnread)
      ? outputRecord.recentUnread
      : [];
    const firstUnread = recentUnread.find((item) => item && typeof item === 'object') as Record<string, unknown> | undefined;
    const content = message?.content && typeof message.content === 'object'
      ? message.content as Record<string, unknown>
      : null;
    const envelope = content?.envelope && typeof content.envelope === 'object'
      ? content.envelope as Record<string, unknown>
      : null;
    const title = envelope && typeof envelope.title === 'string' ? envelope.title.trim() : '';
    const shortDescription = envelope && typeof envelope.shortDescription === 'string'
      ? envelope.shortDescription.trim()
      : '';
    const messageCategory = message && typeof message.category === 'string' ? message.category.trim() : '';
    const messageId = message && typeof message.id === 'string' ? message.id.trim() : '';
    return {
      verb: parseMailboxVerb(normalizedToolName),
      ...(id.length > 0 ? { target: truncateInline(id, 40) } : {}),
      signals: [
        messageId ? `msg=${truncateInline(messageId, 60)}` : '',
        messageCategory ? `cat=${truncateInline(messageCategory, 30)}` : '',
        title ? `title=${truncateInline(title, 100)}` : '',
        shortDescription ? `desc=${truncateInline(shortDescription, 100)}` : '',
        counts && typeof counts.total === 'number' ? `total=${counts.total}` : '',
        counts && typeof counts.unread === 'number' ? `unread=${counts.unread}` : '',
        counts && typeof counts.pending === 'number' ? `pending=${counts.pending}` : '',
        firstUnread && typeof firstUnread.id === 'string' ? `next=${truncateInline(firstUnread.id, 60)}` : '',
      ].filter((item) => item.length > 0),
    };
  }

  if (normalizedToolName === 'web_search' || normalizedToolName === 'search_query') {
    const query = typeof payload.query === 'string'
      ? payload.query.trim()
      : typeof payload.q === 'string'
        ? payload.q.trim()
        : '';
    return {
      verb: 'search',
      ...(query.length > 0 ? { target: truncateInline(query, 48) } : {}),
    };
  }

  if (normalizedToolName === 'view_image') {
    const path = typeof payload.path === 'string' ? payload.path.trim() : '';
    return {
      verb: 'read',
      ...(path.length > 0 ? { target: pickFileName(path) } : {}),
    };
  }

  if (normalizedToolName === 'write_stdin') {
    const stdin = typeof payload.chars === 'string' ? payload.chars.trim() : '';
    const stdout = extractStdout(output);
    const stderr = extractStderr(output);
    return {
      verb: 'run',
      target: 'stdin',
      signals: [
        stdin ? `stdin=${truncateInline(stdin, 100)}` : '',
        stdout ? `stdout=${stdout}` : '',
        stderr ? `stderr=${stderr}` : '',
      ].filter((item) => item.length > 0),
    };
  }

  if (normalizedToolName === 'exec_command' || normalizedToolName === 'shell.exec' || normalizedToolName === 'shell') {
    const command = typeof payload.cmd === 'string'
      ? payload.cmd.trim()
      : typeof payload.command === 'string'
        ? payload.command.trim()
        : '';
    if (command.length === 0) return { verb: 'run' };
    const verb = classifyExecCommand(command);
    const stdout = extractStdout(output);
    const stderr = extractStderr(output);
    return {
      verb,
      target: parseExecCommandTarget(command, verb) ?? truncateInline(command, 64),
      signals: [
        `stdin=${truncateInline(command, 100)}`,
        stdout ? `stdout=${stdout}` : '',
        stderr ? `stderr=${stderr}` : '',
      ].filter((item) => item.length > 0),
      details: {
        command: truncateInline(command, 200),
      },
    };
  }

  return { verb: 'run', target: normalizedToolName };
}

export interface PushSettingsResolverContext {
  channelBridgeManager?: {
    getPushSettings: (channelId: string) => PushSettings;
  };
  resolvePushSettings?: (sessionId: string, channelId: string) => PushSettings;
}

export function resolvePushSettingsForChannel(
  ctx: PushSettingsResolverContext,
  sessionId: string,
  channelId: string,
): PushSettings | null {
  if (typeof ctx.resolvePushSettings === 'function') {
    return ctx.resolvePushSettings(sessionId, channelId);
  }
  if (!ctx.channelBridgeManager) return null;
  return ctx.channelBridgeManager.getPushSettings(channelId);
}

export function shouldPushCommandStyleUpdates(
  ctx: PushSettingsResolverContext,
  sessionId: string,
  mappings: SessionEnvelopeMapping[],
): boolean {
  if (!ctx.channelBridgeManager && typeof ctx.resolvePushSettings !== 'function') return true;
  return mappings.some((mapping) => {
    const settings = resolvePushSettingsForChannel(ctx, sessionId, mapping.envelope.channel);
    if (!settings) return true;
    if (settings.updateMode === 'progress') return false;
    if (settings.updateMode === 'command') return true;
    return settings.toolCalls === true;
  });
}

export function filterStatusMappings(
  ctx: PushSettingsResolverContext,
  sessionId: string,
  mappings: SessionEnvelopeMapping[],
): SessionEnvelopeMapping[] {
  return mappings.filter((mapping) => {
    const settings = resolvePushSettingsForChannel(ctx, sessionId, mapping.envelope.channel);
    if (!settings) return true;
    return settings.statusUpdate;
  });
}

export function buildDispatchMailboxPreviewFromResult(params: {
  targetAgentId: string;
  mailboxMessageId: string;
  resultSummary: string;
  nextAction: string;
}): string {
  return buildDispatchMailboxPreview(params);
}
