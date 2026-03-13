/**
 * Command Hub - Unified <##...##> Command Processing
 * 
 * Single source of truth for all command parsing and execution.
 * Used by: MessageHub, System Agent, CLI
 */

export enum CommandType {
  // System commands
  SYSTEM = 'system',
  SYSTEM_RESTART = 'system_restart',
  PROVIDER_LIST = 'provider_list',
  PROVIDER_SWITCH = 'provider_switch',
  
  // Agent commands
  AGENT = 'agent',
  AGENT_LIST = 'agent_list',
  AGENT_NEW = 'agent_new',
  AGENT_SWITCH = 'agent_switch',
  AGENT_DELETE = 'agent_delete',
  
  // Project commands
  PROJECT_LIST = 'project_list',
  PROJECT_SWITCH = 'project_switch',
  
  // Session commands
  SESSION_LIST = 'session_list',
  SESSION_SWITCH = 'session_switch',
  
  // Utility commands
  CMD_LIST = 'cmd_list',
  HELP = 'help',

  // Clock commands
  CLOCK_CREATE = 'clock_create',
  CLOCK_LIST = 'clock_list',
  CLOCK_CANCEL = 'clock_cancel',

  // Invalid
  INVALID = 'invalid'
}

export interface Command {
  type: CommandType;
  raw: string;
  content: string;
  params: Record<string, any>;
}

export interface CommandContext {
  channel?: string;
  channelId?: string;
  sessionManager?: any;
  eventBus?: any;
  configPath?: string;
  updateContext?: (channelId: string, mode: 'business' | 'system', agentId: string) => void;
}

export interface CommandResult {
  success: boolean;
  output: string;
  error?: string;
  data?: Record<string, unknown>;
}

export interface CommandHandler {
  canHandle(cmd: Command): boolean;
  execute(cmd: Command, ctx: CommandContext): Promise<CommandResult>;
}
