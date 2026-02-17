import { Command } from 'commander';
import { runAppCLI } from '../app/cli.js';

export function registerAppCommand(program: Command) {
  program
    .command('app')
    .description('Start interactive app mode')
    .option('-i, --interactive', 'Interactive mode')
    .option('-p, --prompt <text>', 'Execute single prompt')
    .option('--project <path>', 'Project path')
    .option('-s, --session <id>', 'Resume session by ID')
    .action(async (options) => {
      const args: string[] = [];
      if (options.interactive) args.push('-i');
      if (options.prompt) args.push('-p', options.prompt);
      if (options.project) args.push('--project', options.project);
      if (options.session) args.push('-s', options.session);
      await runAppCLI(args);
    });
}
