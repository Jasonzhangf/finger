import { Command } from 'commander';
import { IFlowSDKWrapper } from '../agents/providers/iflow-sdk-wrapper.js';
import {
  parseCapabilityFile,
  validateCapability,
  applyCapabilityToConfig,
  capabilityTemplate,
} from './capability-loader.js';

interface CommonOptions {
  url: string;
  capability?: string;
}

function buildWrapper(options: CommonOptions): IFlowSDKWrapper {
  return new IFlowSDKWrapper({
    url: options.url,
    autoStartProcess: false,
    permissionMode: 'auto',
  });
}

function loadCapability(path?: string): Record<string, unknown> {
  if (!path) return {};
  const capability = parseCapabilityFile(path);
  const errors = validateCapability(capability);
  if (errors.length > 0) {
    throw new Error(`Capability validation failed: ${errors.join('; ')}`);
  }
  return applyCapabilityToConfig(capability, {});
}

export function registerIflowCommand(program: Command): void {
  const iflow = program.command('iflow').description('iFlow SDK 能力封装 CLI');

  iflow
    .command('status')
    .description('查询 iFlow 连接状态')
    .option('-u, --url <url>', 'iFlow API 地址', 'http://127.0.0.1:5520')
    .action(async (options: CommonOptions) => {
      const wrapper = buildWrapper(options);
      const state = await wrapper.initialize();
      console.log(JSON.stringify({
        connected: state.connected,
        sessionId: state.sessionId,
        executing: state.executing,
      }, null, 2));
      await wrapper.disconnect();
    });

  iflow
    .command('tools')
    .description('查询 iFlow 可用工具列表')
    .option('-u, --url <url>', 'iFlow API 地址', 'http://127.0.0.1:5520')
    .action(async (options: CommonOptions) => {
      const wrapper = buildWrapper(options);
      await wrapper.initialize();
      const tools = wrapper.getAvailableTools();
      console.log(JSON.stringify({ tools, count: tools.length }, null, 2));
      await wrapper.disconnect();
    });

  iflow
    .command('capabilities')
    .description('查询 iFlow commands/agents 能力列表')
    .option('-u, --url <url>', 'iFlow API 地址', 'http://127.0.0.1:5520')
    .action(async (options: CommonOptions) => {
      const wrapper = buildWrapper(options);
      await wrapper.initialize();
      await wrapper.refreshCapabilities();
      console.log(JSON.stringify({
        commands: wrapper.getAvailableCommands(),
        agents: wrapper.getAvailableAgents(),
      }, null, 2));
      await wrapper.disconnect();
    });

  iflow
    .command('run')
    .description('执行任务并返回结果')
    .requiredOption('-t, --task <task>', '任务内容')
    .option('-i, --task-id <taskId>', '任务 ID', `task-${Date.now()}`)
    .option('-u, --url <url>', 'iFlow API 地址', 'http://127.0.0.1:5520')
    .option('-c, --capability <path>', '能力描述文件路径（skill.md 风格）')
    .action(async (options: CommonOptions & { task: string; taskId: string; capability?: string }) => {
      const cfg = loadCapability(options.capability);
      const wrapper = new IFlowSDKWrapper({
        url: options.url,
        autoStartProcess: false,
        permissionMode: String(cfg.permissionMode || 'auto') as 'auto' | 'manual' | 'selective',
      });

      await wrapper.initialize();
      const result = await wrapper.executeTask(options.taskId, options.task);
      console.log(JSON.stringify(result, null, 2));
      await wrapper.disconnect();
    });

  iflow
    .command('template')
    .description('输出能力描述模板')
    .action(() => {
      console.log(capabilityTemplate);
    });
}
