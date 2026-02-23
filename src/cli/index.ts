#!/usr/bin/env node
/**
 * Finger CLI
 * 
 * 命令行接口，封装所有 Agent 功能：
 * - finger understand: 语义理解
 * - finger route: 路由决策
 * - finger plan: 任务规划
 * - finger execute: 任务执行
 * - finger review: 质量审查
 * - finger orchestrate: 编排协调
 * 
 * 使用示例：
 *   finger understand "搜索 deepseek 最新发布"
 *   finger route --intent '{"normalizedIntent": {...}}'
 *   finger plan "搜索 deepseek 最新发布并生成报告"
 *   finger execute --task "创建配置文件" --blocking
 *   finger review --proposal '{"thought": "...", "action": "..."}'
 *   finger orchestrate --task "搜索 deepseek 最新发布" --watch
 */

import { Command } from 'commander';
import {
  understandCommand,
  routeCommand,
  planCommand,
  executeCommand,
  reviewCommand,
  orchestrateCommand,
} from './agent-commands.js';

const program = new Command();

program
  .name('finger')
  .description('AI Agent 编排系统 CLI')
  .version('1.0.0');

// ========== Understand Command ==========
program
  .command('understand')
  .description('语义理解：分析用户输入意图')
  .argument('<input>', '用户输入文本')
  .option('-s, --session <id>', '会话 ID')
  .action(async (input: string, options: { session?: string }) => {
    try {
      await understandCommand(input, { sessionId: options.session });
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

// ========== Route Command ==========
program
  .command('route')
  .description('路由决策：基于语义分析结果决定任务流向')
  .option('-i, --intent <json>', '语义分析结果 JSON')
  .option('-s, --session <id>', '会话 ID')
  .action(async (options: { intent?: string; session?: string }) => {
    try {
      if (!options.intent) {
        console.error('[CLI Error] Missing --intent option');
        process.exit(1);
      }
      await routeCommand(options.intent, { sessionId: options.session });
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

// ========== Plan Command ==========
program
  .command('plan')
  .description('任务规划：将大任务拆解为可执行子任务')
  .argument('<task>', '任务描述')
  .option('-s, --session <id>', '会话 ID')
  .action(async (task: string, options: { session?: string }) => {
    try {
      await planCommand(task, { sessionId: options.session });
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

// ========== Execute Command ==========
program
  .command('execute')
  .description('任务执行：调用工具完成具体任务')
  .option('-t, --task <description>', '任务描述')
  .option('-a, --agent <id>', '执行 Agent ID')
  .option('-b, --blocking', '阻塞模式（等待结果）')
  .action(async (options: { task?: string; agent?: string; blocking?: boolean }) => {
    try {
      if (!options.task) {
        console.error('[CLI Error] Missing --task option');
        process.exit(1);
      }
      await executeCommand(options.task, {
        agent: options.agent,
        blocking: options.blocking,
      });
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

// ========== Review Command ==========
program
  .command('review')
  .description('质量审查：审查计划和执行结果')
  .option('-p, --proposal <json>', '待审查的方案 JSON')
  .action(async (options: { proposal?: string }) => {
    try {
      if (!options.proposal) {
        console.error('[CLI Error] Missing --proposal option');
        process.exit(1);
      }
      await reviewCommand(options.proposal);
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

// ========== Orchestrate Command ==========
program
  .command('orchestrate')
  .description('编排协调：管理整体任务流程')
  .argument('<task>', '任务描述')
  .option('-s, --session <id>', '会话 ID')
  .option('-w, --watch', '监视模式（持续输出事件）')
  .action(async (task: string, options: { session?: string; watch?: boolean }) => {
    try {
      await orchestrateCommand(task, {
        sessionId: options.session,
        watch: options.watch,
      });
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

// ========== Status Command ==========
program
  .command('status')
  .description('查看工作流状态')
  .argument('<workflowId>', '工作流 ID')
  .action(async (workflowId: string) => {
    try {
      const res = await fetch(`http://localhost:8080/api/v1/workflows/${workflowId}/state`);
      if (!res.ok) {
        throw new Error(`Failed to get status: ${res.statusText}`);
      }
      const snapshot = await res.json();
      console.log('Workflow Status:');
      console.log(JSON.stringify(snapshot, null, 2));
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

// ========== List Command ==========
program
  .command('list')
  .description('列出所有工作流状态')
  .action(async () => {
    try {
      const res = await fetch('http://localhost:8080/api/v1/workflows/state');
      if (!res.ok) {
        throw new Error(`Failed to list workflows: ${res.statusText}`);
      }
      const { snapshots } = await res.json();
      console.log('Workflows:');
      snapshots.forEach((s: any) => {
        console.log(`  - ${s.workflowId}: ${s.fsmState} (${s.simplifiedStatus})`);
      });
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

program.parse();

// ========== REPL Command ==========
program
  .command('repl')
  .description('交互式模式：实时对话和任务管理')
  .option('--http-url <url>', 'HTTP API URL', 'http://localhost:8080')
  .option('--ws-url <url>', 'WebSocket URL', 'ws://localhost:8081')
  .action(async (options: { httpUrl: string; wsUrl: string }) => {
    try {
      const { startREPL } = await import('./repl.js');
      await startREPL({
        httpUrl: options.httpUrl,
        wsUrl: options.wsUrl,
      });
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

// ========== Pause Command ==========
program
  .command('pause')
  .description('暂停工作流')
  .argument('<workflowId>', '工作流 ID')
  .action(async (workflowId: string) => {
    try {
      const res = await fetch('http://localhost:8080/api/v1/workflow/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId }),
      });
      const result = await res.json();
      console.log('Workflow paused:', result);
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

// ========== Resume Command ==========
program
  .command('resume')
  .description('恢复工作流')
  .argument('<workflowId>', '工作流 ID')
  .action(async (workflowId: string) => {
    try {
      const res = await fetch('http://localhost:8080/api/v1/workflow/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId }),
      });
      const result = await res.json();
      console.log('Workflow resumed:', result);
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

// ========== Input Command ==========
program
  .command('input')
  .description('发送用户输入到工作流')
  .argument('<workflowId>', '工作流 ID')
  .argument('<input>', '输入内容')
  .action(async (workflowId: string, input: string) => {
    try {
      const res = await fetch('http://localhost:8080/api/v1/workflow/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId, input }),
      });
      const result = await res.json();
      console.log('Input sent:', result);
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

// ========== Daemon Commands ==========
import { registerDaemonCommand } from './daemon.js';
registerDaemonCommand(program);
