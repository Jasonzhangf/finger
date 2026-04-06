import { Command } from 'commander';
import { spawn } from 'child_process';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';

const clog = createConsoleLikeLogger('FingerShortcuts');

function runNpmScript(scriptName: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', scriptName], {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: true,
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

export function registerFingerShortcuts(program: Command): void {
  program
    .command('restart')
    .description('Shortcut: restart Finger daemon (npm run daemon:restart)')
    .action(async () => {
      const code = await runNpmScript('daemon:restart');
      process.exit(code);
    });

  program
    .command('status')
    .description('Shortcut: show daemon status (npm run daemon:status if exists, fallback daemon status)')
    .action(async () => {
      const code = await runNpmScript('daemon:status');
      if (code === 0) {
        process.exit(0);
        return;
      }
      clog.log('daemon:status script not found or failed, fallback to legacy --status (composite runtime status)');
      const fallback = spawn(process.execPath, [process.argv[1] ?? 'dist/cli/index.js', '--status'], {
        cwd: process.cwd(),
        stdio: 'inherit',
        shell: true,
      });
      fallback.on('exit', (c) => process.exit(c ?? 1));
      fallback.on('error', () => process.exit(1));
    });
}
