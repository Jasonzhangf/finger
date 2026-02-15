import { Command } from 'commander';
import { EventBusBlock } from '../blocks/eventbus-block/index.js';
import { MessageBus } from '../agents/runtime/message-bus.js';
import { ToolRegistry } from '../agents/shared/tool-registry.js';
import { ExecutionLoop, LoopConfig } from '../agents/runtime/execution-loop.js';
import { ExecutorConfig } from '../agents/roles/executor.js';
import { getAllTools } from '../agents/shared/tools.js';

/**
 * 注册 loop test CLI 命令
 */
export function registerLoopTestCommand(program: Command): void {
  program
    .command('loop-test')
    .description('使用 iFlow SDK 测试编排循环')
    .option('-t, --task <task>', '原始任务描述', '创建一个简单的 Node.js 项目')
    .option('-u, --url <url>', 'iFlow API 地址', 'http://127.0.0.1:5520')
    .option('-k, --key <key>', 'API Key', 'test-key')
    .option('-m, --model <model>', '默认模型', 'iflow.kimi-k2.5')
    .option('-r, --rounds <rounds>', '最大轮数', '3')
    .action(async (options) => {
      try {
        console.log('🚀 启动编排循环测试...\n');
        console.log(`任务: ${options.task}`);
        console.log(`API: ${options.url}`);
        console.log(`模型: ${options.model}`);
        console.log(`最大轮数: ${options.rounds}\n`);

        // 1. 初始化基础设施
        const eventBus = new EventBusBlock('test-eventbus');
        const messageBus = new MessageBus(eventBus);
        const toolRegistry = new ToolRegistry();

        // 注册所有标准工具
        for (const tool of getAllTools()) {
          toolRegistry.register(tool);
        }
        console.log(`✓ 已注册 ${getAllTools().length} 个工具`);

        // 2. 配置编排循环
        const loopConfig: LoopConfig = {
          orchestrator: {
            id: 'orchestrator-1',
            systemPrompt: '你是一个任务编排专家。请将用户任务拆解为可并行执行的子任务。',
            provider: {
              baseUrl: options.url,
              apiKey: options.key,
              defaultModel: options.model,
            },
          },
          maxRounds: parseInt(options.rounds, 10),
          timeout: 30000,
        };

        const loop = new ExecutionLoop(messageBus, toolRegistry, loopConfig);
        console.log('✓ 编排循环已初始化');

        // 3. 注册执行者
        const executor1: ExecutorConfig = {
          id: 'executor-1',
          systemPrompt: '你是一个任务执行者。请完成分配给你的任务。',
          provider: {
            baseUrl: options.url,
            apiKey: options.key,
            defaultModel: options.model,
          },
          toolRegistry,
        };

        const executor2: ExecutorConfig = {
          id: 'executor-2',
          systemPrompt: '你是一个任务执行者。请完成分配给你的任务。',
          provider: {
            baseUrl: options.url,
            apiKey: options.key,
            defaultModel: options.model,
          },
          toolRegistry,
        };

        loop.registerExecutor(executor1);
        loop.registerExecutor(executor2);
        console.log('✓ 已注册 2 个执行者\n');

        // 4. 运行编排循环
        console.log('▶ 开始执行...\n');
        const result = await loop.run(options.task);

        // 5. 输出结果
        console.log('\n=== 执行结果 ===');
        console.log(`成功: ${result.success}`);
        console.log(`总耗时: ${result.duration}ms`);
        console.log(`轮数: ${result.totalRounds}`);
        console.log(`完成任务: ${result.completedTasks.length}`);
        console.log(`失败任务: ${result.failedTasks.length}`);

        if (result.completedTasks.length > 0) {
          console.log('\n完成任务列表:');
          for (const task of result.completedTasks) {
            console.log(`  ✓ ${task.taskId}: ${task.description}`);
          }
        }

        if (result.failedTasks.length > 0) {
          console.log('\n失败任务列表:');
          for (const task of result.failedTasks) {
            console.log(`  ✗ ${task.taskId}: ${task.description}`);
          }
        }

        process.exit(result.success ? 0 : 1);
      } catch (error) {
        console.error('❌ 测试失败:', error);
        process.exit(1);
      }
    });
}
