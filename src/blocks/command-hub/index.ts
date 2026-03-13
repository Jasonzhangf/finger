/**
 * Command Hub - Unified <##...##> Command Processing Block
 * 
 * Single source of truth for all command parsing and execution.
 * Used by: MessageHub, System Agent, CLI
 */

export * from './types.js';
export * from './parser.js';
export * from './executor.js';
export * from './handlers/index.js';

import { CommandExecutor } from './executor.js';
import { CommandType } from './types.js';
import {
  SystemRestartHandler,
  SystemSwitchHandler,
  ProviderListHandler,
  ProviderSwitchHandler
} from './handlers/index.js';
import { AgentSwitchHandler } from './handlers/agent-handler.js';
import { ProjectSwitchHandler } from './handlers/project-handler.js';
import { SessionSwitchHandler } from './handlers/session-handler.js';

let executor: CommandExecutor | null = null;

/**
 * Initialize Command Hub with all handlers registered
 */
export function initCommandHub(): CommandExecutor {
  if (executor) {
    return executor;
  }

  executor = new CommandExecutor();

  // Register system command handlers
  executor.registerHandler(CommandType.SYSTEM, new SystemSwitchHandler());
  executor.registerHandler(CommandType.SYSTEM_RESTART, new SystemRestartHandler());
  executor.registerHandler(CommandType.PROVIDER_LIST, new ProviderListHandler());
  executor.registerHandler(CommandType.PROVIDER_SWITCH, new ProviderSwitchHandler());

  // Register agent command handlers
  executor.registerHandler(CommandType.AGENT, new AgentSwitchHandler());
  executor.registerHandler(CommandType.AGENT_LIST, new AgentSwitchHandler());
  executor.registerHandler(CommandType.AGENT_NEW, new AgentSwitchHandler());
  executor.registerHandler(CommandType.AGENT_SWITCH, new AgentSwitchHandler());
  executor.registerHandler(CommandType.AGENT_DELETE, new AgentSwitchHandler());

  // Register project command handlers
  executor.registerHandler(CommandType.PROJECT_LIST, new ProjectSwitchHandler());
  executor.registerHandler(CommandType.PROJECT_SWITCH, new ProjectSwitchHandler());

  // Register session command handlers
  executor.registerHandler(CommandType.SESSION_LIST, new SessionSwitchHandler());
  executor.registerHandler(CommandType.SESSION_SWITCH, new SessionSwitchHandler());

  // TODO: Add more handlers (agent, project, session, cmd_list)

  return executor;
}

/**
 * Get the global Command Hub executor
 */
export function getCommandHub(): CommandExecutor {
  if (!executor) {
    return initCommandHub();
  }
  return executor;
}
