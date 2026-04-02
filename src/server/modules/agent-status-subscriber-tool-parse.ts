import type { ToolVerb } from './agent-status-subscriber-handler-helpers.js';

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
  return token.startsWith('~')
    || token.startsWith('/')
    || token.startsWith('./')
    || token.startsWith('../')
    || /^[A-Za-z]:[\\/]/.test(token)
    || /[\\/]/.test(token)
    || /\.[A-Za-z0-9_-]{1,8}$/.test(token);
}

function pickFileName(token: string): string {
  const normalized = token.trim().replace(/\\/g, '/');
  const compact = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  const parts = compact.split('/').filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? token;
}

export function classifyExecCommand(command: string): ToolVerb {
  const normalized = command.trim().toLowerCase();
  if (normalized.length === 0) return 'run';
  if (/(^|\s)(rg|grep|find|fd)\b/.test(normalized)) return 'search';
  if (/(^|\s)(cat|sed|head|tail|less|more|ls|pwd|stat|wc|du|git\s+(show|status|log|diff))\b/.test(normalized)) return 'read';
  if (/(^|\s)(echo|tee|cp|mv|rm|mkdir|rmdir|touch|chmod|chown|git\s+(add|commit|checkout|restore)|npm\s+install|pnpm\s+install|yarn\s+add)\b/.test(normalized) || />\s*[^ ]/.test(normalized)) {
    return 'write';
  }
  return 'run';
}

export function parseExecCommandTarget(command: string, verb: ToolVerb): string | undefined {
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

export function parseMailboxVerb(toolName: string): ToolVerb {
  const action = toolName.replace(/^mailbox\./i, '').toLowerCase();
  if (action === 'ack' || action === 'remove' || action === 'remove_all') return 'write';
  return 'read';
}

