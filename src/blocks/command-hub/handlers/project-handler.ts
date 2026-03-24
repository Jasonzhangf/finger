/**
 * Project Command Handlers
 */

import { Command, CommandContext, CommandResult, CommandType, CommandHandler } from '../types.js';

export class ProjectSwitchHandler implements CommandHandler {
  canHandle(cmd: Command): boolean {
    return cmd.type === CommandType.PROJECT_SWITCH || cmd.type === CommandType.PROJECT_LIST;
  }

  async execute(cmd: Command, ctx: CommandContext): Promise<CommandResult> {
    if (ctx.updateContext && ctx.channelId) {
      ctx.updateContext(ctx.channelId, 'business', 'finger-project-agent');
    }

    return {
      success: true,
      output: '项目切换已更新上下文（切回 Orchestrator）'
    };
  }
}
