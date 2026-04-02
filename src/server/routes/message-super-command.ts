import type { MessageRouteDeps } from './message-types.js';
import { parseSuperCommand } from '../middleware/super-command-parser.js';
import {
  handleCmdList,
  handleAgentList,
  handleAgentNew,
  handleAgentSwitch,
  handleAgentDelete,
  handleSystemCommand,
  handleSystemProgressMode,
  handleDisplayCommand,
  handleProjectList,
  handleProjectSwitch,
} from '../modules/messagehub-command-handler.js';
import { validateSystemCommand } from '../middleware/system-auth.js';
import { getChannelContextManager } from '../../orchestration/channel-context-manager.js';

export interface SuperCommandResult {
  handled: boolean;
  response?: unknown;
  shouldSwitch?: boolean;
  targetAgent?: string;
}

/**
 * Handle super commands (slash commands).
 * Returns { handled: true, response } if the command was fully handled (respond directly).
 * Returns { handled: true, shouldSwitch, targetAgent } if context switch needed but message still processed.
 * Returns { handled: false } if no super command detected.
 */
export async function handleSuperCommand(
  incomingContent: string,
  channelId: string,
  deps: MessageRouteDeps,
): Promise<SuperCommandResult> {
  const parsedCommand = parseSuperCommand(incomingContent);

  if (parsedCommand.type !== 'super_command' || !parsedCommand.blocks || parsedCommand.blocks.length === 0) {
    return { handled: false };
  }

  const firstBlock = parsedCommand.blocks[0];

  // Validate system commands
  if (firstBlock.type === 'system') {
    const auth = await validateSystemCommand(firstBlock, channelId);
    if (!auth.ok) {
      return { handled: true, response: { error: auth.error, code: 'SYSTEM_AUTH_FAILED' }, shouldSwitch: false };
    }
  }

  // Command responses (return plain text for QQ/WebUI)
  const commandHandlers: Record<string, () => Promise<unknown>> = {
    cmd_list: handleCmdList,
    agent_list: () => handleAgentList(deps.sessionManager, firstBlock.path),
    agent_new: () => handleAgentNew(deps.sessionManager, firstBlock.path, deps.eventBus),
    system: () => {
      if (typeof firstBlock.content === 'string' && firstBlock.content.startsWith('progress_mode:')) {
        const mode = firstBlock.content.slice('progress_mode:'.length);
        return handleSystemProgressMode(mode);
      }
      return handleSystemCommand(deps.sessionManager, deps.eventBus);
    },
    display: () => handleDisplayCommand(channelId, firstBlock.content, deps.channelBridgeManager),
    project_list: () => handleProjectList(deps.sessionManager),
  };

  const switchHandlers: Record<string, () => Promise<unknown>> = {
    agent_switch: () => handleAgentSwitch(deps.sessionManager, firstBlock.sessionId!, deps.eventBus),
    agent_delete: () => handleAgentDelete(deps.sessionManager, firstBlock.sessionId!, deps.eventBus),
    project_switch: () => handleProjectSwitch(deps.sessionManager, firstBlock.path!, deps.eventBus),
  };

  if (commandHandlers[firstBlock.type]) {
    const result = await commandHandlers[firstBlock.type]();
    return { handled: true, response: { messageId: `cmd-${Date.now()}`, status: 'completed', result } };
  }

  if (switchHandlers[firstBlock.type]) {
    const result = await switchHandlers[firstBlock.type]();
    return { handled: true, response: { messageId: `cmd-${Date.now()}`, status: 'completed', result }, shouldSwitch: parsedCommand.shouldSwitch, targetAgent: parsedCommand.targetAgent };
  }

  // Context switch handling (no command response, but update context)
  if (parsedCommand.shouldSwitch && parsedCommand.targetAgent) {
    const contextManager = getChannelContextManager();
    const currentSession = deps.sessionManager.getCurrentSession();
    const previousContext = currentSession ? {
      agentId: contextManager.getTargetAgent(channelId, { type: 'normal', targetAgent: '' }),
      sessionId: currentSession.id,
      projectPath: currentSession.projectPath,
    } : undefined;

    if (parsedCommand.targetAgent === 'finger-system-agent') {
      contextManager.updateContext(channelId, 'system', 'finger-system-agent', previousContext);
    } else if (parsedCommand.targetAgent === 'finger-project-agent' || parsedCommand.targetAgent === 'finger-orchestrator') {
      contextManager.updateContext(channelId, 'business', 'finger-project-agent');
    }

    return { handled: false, shouldSwitch: true, targetAgent: parsedCommand.targetAgent };
  }

  return { handled: false };
}
