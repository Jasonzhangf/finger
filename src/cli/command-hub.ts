import type { Command as CliCommand } from 'commander';
import { parseCommands, getCommandHub } from '../blocks/command-hub/index.js';
import { ensureFingerLayout, FINGER_PATHS } from '../core/finger-paths.js';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';

const clog = createConsoleLikeLogger('CommandHub');

interface CommandHubOptions {
  channel?: string;
  configPath?: string;
}

export function registerCommandHubCommand(program: CliCommand): void {
  program
    .command('cmd')
    .description('执行 <##...##> 共享命令')
    .argument('<input>', '命令字符串，例如 <##@system:provider:list##>')
    .option('-c, --channel <channel>', 'Channel ID', 'cli')
    .option('--config <path>', 'Config path (default ~/.finger/config/config.json)')
    .action(async (input: string, options: CommandHubOptions) => {
      try {
        ensureFingerLayout();

        const parsed = parseCommands(input);
        if (parsed.commands.length === 0) {
          clog.error('未检测到命令: ', input);
          process.exit(1);
          return;
        }

        const executor = getCommandHub();
        const ctx = {
          channelId: options.channel || 'cli',
          configPath: options.configPath || `${FINGER_PATHS.config.dir}/config.json`,
        };

        const result = await executor.execute(parsed.commands[0], ctx);
        if (result.success) {
          clog.log(result.output);
          process.exit(0);
        } else {
          clog.error(result.error || result.output || '命令执行失败');
          process.exit(1);
        }
      } catch (err) {
        clog.error('[CLI Error]', err);
        process.exit(1);
      }
    });
}
