export interface SlashCommandDefinition {
  name: string;
  description: string;
  supportsInlineArgs: boolean;
  implemented: boolean;
}

export interface ParsedSlashCommand {
  name: string;
  args: string[];
  rawArgs: string;
}

// Ordered to match Codex popup priority.
export const CODEX_SLASH_COMMANDS: SlashCommandDefinition[] = [
  { name: 'model', description: 'choose what model and reasoning effort to use', supportsInlineArgs: false, implemented: false },
  { name: 'approvals', description: 'choose what Codex is allowed to do', supportsInlineArgs: false, implemented: false },
  { name: 'permissions', description: 'choose what Codex is allowed to do', supportsInlineArgs: false, implemented: false },
  { name: 'setup-default-sandbox', description: 'set up elevated agent sandbox', supportsInlineArgs: false, implemented: false },
  { name: 'sandbox-add-read-dir', description: 'let sandbox read a directory', supportsInlineArgs: true, implemented: false },
  { name: 'experimental', description: 'toggle experimental features', supportsInlineArgs: false, implemented: false },
  { name: 'skills', description: 'use skills to improve how Codex performs specific tasks', supportsInlineArgs: false, implemented: false },
  { name: 'review', description: 'review my current changes and find issues', supportsInlineArgs: true, implemented: true },
  { name: 'rename', description: 'rename the current thread', supportsInlineArgs: true, implemented: false },
  { name: 'new', description: 'start a new chat during a conversation', supportsInlineArgs: false, implemented: true },
  { name: 'resume', description: 'resume a saved chat', supportsInlineArgs: false, implemented: false },
  { name: 'fork', description: 'fork the current chat', supportsInlineArgs: false, implemented: false },
  { name: 'init', description: 'create an AGENTS.md file with instructions for Codex', supportsInlineArgs: false, implemented: false },
  { name: 'compact', description: 'summarize conversation to prevent hitting context limit', supportsInlineArgs: false, implemented: true },
  { name: 'plan', description: 'switch to Plan mode', supportsInlineArgs: true, implemented: true },
  { name: 'collab', description: 'change collaboration mode (experimental)', supportsInlineArgs: false, implemented: false },
  { name: 'agent', description: 'switch the active agent thread', supportsInlineArgs: false, implemented: false },
  { name: 'diff', description: 'show git diff (including untracked files)', supportsInlineArgs: false, implemented: false },
  { name: 'mention', description: 'mention a file', supportsInlineArgs: false, implemented: false },
  { name: 'status', description: 'show current session configuration and token usage', supportsInlineArgs: false, implemented: true },
  { name: 'debug-config', description: 'show config layers and requirement sources for debugging', supportsInlineArgs: false, implemented: false },
  { name: 'statusline', description: 'configure which items appear in the status line', supportsInlineArgs: false, implemented: false },
  { name: 'theme', description: 'choose a syntax highlighting theme', supportsInlineArgs: false, implemented: false },
  { name: 'mcp', description: 'list configured MCP tools', supportsInlineArgs: false, implemented: false },
  { name: 'apps', description: 'manage apps', supportsInlineArgs: false, implemented: false },
  { name: 'logout', description: 'log out of Codex', supportsInlineArgs: false, implemented: false },
  { name: 'quit', description: 'exit Codex', supportsInlineArgs: false, implemented: true },
  { name: 'exit', description: 'exit Codex', supportsInlineArgs: false, implemented: true },
  { name: 'feedback', description: 'send logs to maintainers', supportsInlineArgs: false, implemented: false },
  { name: 'rollout', description: 'print the rollout file path', supportsInlineArgs: false, implemented: false },
  { name: 'ps', description: 'list background terminals', supportsInlineArgs: false, implemented: false },
  { name: 'clean', description: 'stop all background terminals', supportsInlineArgs: false, implemented: false },
  { name: 'clear', description: 'clear terminal and start a new chat', supportsInlineArgs: false, implemented: true },
  { name: 'help', description: 'list available slash commands', supportsInlineArgs: false, implemented: true },
  { name: 'personality', description: 'choose a communication style for Codex', supportsInlineArgs: false, implemented: false },
  { name: 'test-approval', description: 'test approval request', supportsInlineArgs: false, implemented: false },
  { name: 'debug-m-drop', description: 'debug memory drop', supportsInlineArgs: false, implemented: false },
  { name: 'debug-m-update', description: 'debug memory update', supportsInlineArgs: false, implemented: false },
];

const COMMAND_MAP = new Map<string, SlashCommandDefinition>(
  CODEX_SLASH_COMMANDS.map((item) => [item.name, item]),
);

export function parseSlashCommandInput(text: string): ParsedSlashCommand | null {
  const normalized = text.trim();
  if (!normalized.startsWith('/')) return null;
  const withoutPrefix = normalized.slice(1).trim();
  if (withoutPrefix.length === 0) return null;
  const [name, ...args] = withoutPrefix.split(/\s+/);
  const normalizedName = name.toLowerCase();
  if (!COMMAND_MAP.has(normalizedName)) return null;
  return {
    name: normalizedName,
    args,
    rawArgs: args.join(' ').trim(),
  };
}

export function listImplementedSlashCommands(): SlashCommandDefinition[] {
  return CODEX_SLASH_COMMANDS.filter((item) => item.implemented);
}

export function getSlashCommandDefinition(name: string): SlashCommandDefinition | undefined {
  return COMMAND_MAP.get(name.trim().toLowerCase());
}
