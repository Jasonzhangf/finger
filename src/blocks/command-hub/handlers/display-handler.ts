/**
 * Display Command Handler
 */

import * as path from 'path';
import { Command, CommandContext, CommandHandler, CommandResult, CommandType } from '../types.js';
import { handleDisplayCommand } from '../../../server/modules/messagehub-display-command.js';

export class DisplayHandler implements CommandHandler {
  canHandle(cmd: Command): boolean {
    return cmd.type === CommandType.DISPLAY;
  }

  async execute(cmd: Command, ctx: CommandContext): Promise<CommandResult> {
    const channelId = typeof ctx.channelId === 'string' && ctx.channelId.trim().length > 0
      ? ctx.channelId.trim()
      : '';
    if (!channelId) {
      return {
        success: false,
        output: '',
        error: 'display command requires channelId',
      };
    }

    const spec = typeof cmd.params?.spec === 'string' ? cmd.params.spec.trim() : '';
    if (!spec) {
      return {
        success: false,
        output: '',
        error: 'display command requires a non-empty spec',
      };
    }

    const configDir = (() => {
      if (typeof ctx.configPath !== 'string' || ctx.configPath.trim().length === 0) return undefined;
      return path.dirname(ctx.configPath.trim());
    })();

    const output = await handleDisplayCommand(
      channelId,
      spec,
      ctx.channelBridgeManager as any,
      configDir ? { configDir } : undefined,
    );

    const success = !output.startsWith('❌');
    return {
      success,
      output,
      ...(success ? {} : { error: output }),
    };
  }
}

