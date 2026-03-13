/**
 * Session Command Handlers
 */

import { Command, CommandContext, CommandResult, CommandType, CommandHandler } from '../types.js';

export class SessionSwitchHandler implements CommandHandler {
  canHandle(cmd: Command): boolean {
    return cmd.type === CommandType.SESSION_LIST || cmd.type === CommandType.SESSION_SWITCH;
  }

  async execute(cmd: Command, ctx: CommandContext): Promise<CommandResult> {
    // Session switch should not change agent context by default
    return {
      success: true,
      output: 'Session 命令已解析（上下文保持不变）'
    };
  }
}
