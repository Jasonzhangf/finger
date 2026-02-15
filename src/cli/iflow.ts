import { Command } from 'commander';
import { IflowBaseAgent } from '../agents/sdk/iflow-base.js';
import { IflowInteractiveAgent } from '../agents/sdk/iflow-interactive.js';
import { runIflowCapabilityTest } from '../agents/sdk/iflow-capability-test.js';
import * as readline from 'readline';

interface CommonOptions {
  cwd?: string;
  addDir?: string[];
  capability?: string;
}

function buildBaseAgent(options: CommonOptions): IflowBaseAgent {
  return new IflowBaseAgent({
    autoStartProcess: true,
    cwd: options.cwd,
    sessionSettings: options.addDir ? { add_dirs: options.addDir } : undefined,
  });
}

export function registerIflowCommand(program: Command): void {
  const iflow = program.command('iflow').description('iFlow SDK 能力封装 CLI');

  // status: 基础接口 - 查询连接状态
  iflow
    .command('status')
    .description('查询 iFlow 连接状态和 session 信息')
    .option('-d, --cwd <dir>', '工作目录')
    .option('--add-dir <dirs...>', '额外包含目录')
    .action(async (options: CommonOptions) => {
      const agent = buildBaseAgent(options);
      try {
        const info = await agent.initialize();
        console.log(JSON.stringify({
          connected: info.connected,
          sessionId: info.sessionId,
          cwd: info.cwd,
          addDirs: info.addDirs,
          commands: info.availableCommands.length,
          agents: info.availableAgents.length,
          skills: info.availableSkills.length,
          mcpServers: info.availableMcpServers.length,
        }, null, 2));
      } catch (err) {
        console.error('Failed to connect:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        await agent.disconnect();
      }
    });

  // tools: 基础接口 - 查询 MCP 服务器列表 (iFlow 的工具以 MCP 形式提供)
  iflow
    .command('tools')
    .description('查询 iFlow 可用工具列表 (MCP Servers)')
    .option('-d, --cwd <dir>', '工作目录')
    .option('--add-dir <dirs...>', '额外包含目录')
    .action(async (options: CommonOptions) => {
      const agent = buildBaseAgent(options);
      try {
        const info = await agent.initialize();
        console.log(JSON.stringify({
          cwd: info.cwd,
          addDirs: info.addDirs,
          tools: info.availableMcpServers,
          count: info.availableMcpServers.length,
        }, null, 2));
      } catch (err) {
        console.error('Failed to get tools:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        await agent.disconnect();
      }
    });

  // capabilities: 基础接口 - 查询所有能力
  iflow
    .command('capabilities')
    .description('查询 iFlow commands/agents/skills 能力列表')
    .option('-d, --cwd <dir>', '工作目录')
    .option('--add-dir <dirs...>', '额外包含目录')
    .action(async (options: CommonOptions) => {
      const agent = buildBaseAgent(options);
      try {
        const info = await agent.initialize();
        console.log(JSON.stringify({
          cwd: info.cwd,
          addDirs: info.addDirs,
          commands: info.availableCommands,
          agents: info.availableAgents,
          skills: info.availableSkills,
          mcpServers: info.availableMcpServers,
        }, null, 2));
      } catch (err) {
        console.error('Failed to get capabilities:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        await agent.disconnect();
      }
    });

  iflow
    .command('capability-test')
    .description('执行 iFlow SDK 标准能力测试并输出能力清单')
    .option('-d, --cwd <dir>', '工作目录')
    .option('--add-dir <dirs...>', '额外包含目录')
    .action(async (options: CommonOptions) => {
      try {
        const report = await runIflowCapabilityTest({
          cwd: options.cwd,
          addDir: options.addDir,
        });
        console.log(JSON.stringify(report, null, 2));
      } catch (err) {
        console.error('Capability test failed:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // run: 交互接口 - 非交互式任务执行
  iflow
    .command('run')
    .description('执行任务并返回结果')
    .requiredOption('-t, --task <task>', '任务内容')
    .option('-d, --cwd <dir>', '工作目录')
    .option('--add-dir <dirs...>', '额外包含目录')
    .option('-c, --capability <path>', '能力描述文件路径（暂未实现）')
    .action(async (options: CommonOptions & { task: string }) => {
      const agent = new IflowInteractiveAgent({ 
        autoStartProcess: true, 
        permissionMode: 'auto',
        cwd: options.cwd,
        sessionSettings: options.addDir ? { add_dirs: options.addDir } : undefined,
      });
      try {
        await agent.initialize();
        console.log('Executing task...');
        const result = await agent.interact(options.task, {
          onAssistantChunk: (chunk) => process.stdout.write(chunk),
        });
        console.log('\n\nResult:', JSON.stringify(result, null, 2));
      } catch (err) {
        console.error('\nTask failed:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        await agent.disconnect();
      }
    });

  // chat: 交互接口 - 交互式聊天
  iflow
    .command('chat')
    .description('进入交互式聊天模式')
    .option('-d, --cwd <dir>', '工作目录')
    .option('--add-dir <dirs...>', '额外包含目录')
    .action(async (options: CommonOptions) => {
      const agent = new IflowInteractiveAgent({ 
        autoStartProcess: true, 
        permissionMode: 'auto',
        cwd: options.cwd,
        sessionSettings: options.addDir ? { add_dirs: options.addDir } : undefined,
      });
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const question = (prompt: string): Promise<string> => 
        new Promise(resolve => rl.question(prompt, resolve));

      try {
        await agent.initialize();
        console.log('Connected to iFlow. Type "exit" to quit.\n');

        while (true) {
          const input = await question('You: ');
          if (input.toLowerCase() === 'exit') break;

          process.stdout.write('Assistant: ');
          await agent.interact(input, {
            onAssistantChunk: (chunk) => process.stdout.write(chunk),
          });
          console.log('\n');
        }
      } catch (err) {
        console.error('\nChat error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        rl.close();
        await agent.disconnect();
      }
    });
}
