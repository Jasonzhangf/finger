/**
 * Orchestrate command - with watch mode support
 */

import { Command } from 'commander';
import { orchestrateCommand } from '../agent-commands.js';

export function registerOrchestrateCommand(program: Command): void {
  program
    .command('orchestrate')
    .description('编排协调：管理整体任务流程')
    .argument('<task>', '任务描述')
    .option('-s, --session <id>', '会话 ID')
    .option('-w, --watch', '监视模式（持续输出事件）')
    .option('--json', 'JSON 输出格式')
    .option('--stream', 'SSE 流式输出')
    .action(async (task: string, options: { session?: string; watch?: boolean; json?: boolean; stream?: boolean }) => {
      try {
        await orchestrateCommand(task, {
          sessionId: options.session,
          watch: options.watch,
          json: options.json,
          stream: options.stream,
        });
      } catch (error) {
        console.error('[CLI Error]', error);
        process.exit(1);
      }
    });
}
