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
  SystemProgressModeHandler,
  SystemSwitchHandler,
  ProviderListHandler,
  ProviderSwitchHandler,
  DisplayHandler,
} from './handlers/index.js';
import { ClockCreateHandler } from './handlers/system-handler.js';
import { AgentSwitchHandler } from './handlers/agent-handler.js';
import { ProjectSwitchHandler } from './handlers/project-handler.js';
import { SessionSwitchHandler } from './handlers/session-handler.js';
import { AuthGrantHandler, AuthDenyHandler, AuthStatusHandler } from './handlers/auth-handler.js';

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
  executor.registerHandler(CommandType.SYSTEM_PROGRESS_MODE, new SystemProgressModeHandler());
  executor.registerHandler(CommandType.PROVIDER_LIST, new ProviderListHandler());
  executor.registerHandler(CommandType.PROVIDER_SWITCH, new ProviderSwitchHandler());

  // Register clock command handlers
  executor.registerHandler(CommandType.CLOCK_CREATE, new ClockCreateHandler());

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

  // Register auth/permission command handlers
  executor.registerHandler(CommandType.AUTH_GRANT, new AuthGrantHandler());
  executor.registerHandler(CommandType.AUTH_DENY, new AuthDenyHandler());
  executor.registerHandler(CommandType.AUTH_STATUS, new AuthStatusHandler());

  // Register display command handler
  executor.registerHandler(CommandType.DISPLAY, new DisplayHandler());

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
