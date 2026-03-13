/**
 * Agent Command Handlers
 */

import { Command, CommandContext, CommandResult, CommandType, CommandHandler } from '../types.js';

export class AgentSwitchHandler implements CommandHandler {
  canHandle(cmd: Command): boolean {
    return cmd.type === CommandType.AGENT || cmd.type === CommandType.AGENT_LIST || cmd.type === CommandType.AGENT_NEW || cmd.type === CommandType.AGENT_SWITCH || cmd.type === CommandType.AGENT_DELETE;
  }

  async execute(cmd: Command, ctx: CommandContext): Promise<CommandResult> {
    if (ctx.updateContext && ctx.channelId) {
      ctx.updateContext(ctx.channelId, 'business', 'finger-orchestrator');
    }

    return {
      success: true,
      output: '已切换到 Orchestrator（上下文持久）'
    };
  }
}
