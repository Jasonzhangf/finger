#!/usr/bin/env node
/**
 * RouterChatAgent CLI - 独立 CLI 入口
 * 
 * 启动方式:
 *   node dist/agents/router-chat/router-chat-cli.js
 * 
 * 模式:
 *   --dryrun  只输出路由决策，不实际路由
 *   --interactive  交互式测试
 */

import { Command } from 'commander';
import { logger } from '../../core/logger.js';
import { RouterChatAgent } from './router-chat-agent.js';
import { AgentCLIBase, type AgentCLIConfig } from '../cli-base/agent-cli-base.js';
import { MessageHub } from '../../orchestration/message-hub.js';
import { IflowSessionManager } from '../chat/iflow-session-manager.js';

const log = logger.module('RouterChatCLI');

// Dryrun 模式 - 只输出路由决策
async function dryrunTest(text: string, verbose: boolean): Promise<void> {
  console.log('\n=== Router Agent Dryrun Test ===\n');
  console.log(`输入: "${text}"\n`);

  const agent = new RouterChatAgent();
  const hub = new MessageHub();
  const sessionManager = new IflowSessionManager();
  
  await sessionManager.initialize();
  await agent.initializeHub(hub, sessionManager);

  // 模拟输入
  const input = {
    text,
    sessionId: 'dryrun-test',
    sender: { id: 'test-user', name: 'Test User' },
  };

  // 获取路由决策（不实际路由）
  const decision = await agent['analyzeAndDecide'](input);

  console.log('=== 路由决策 ===');
  console.log(JSON.stringify(decision, null, 2));

  if (verbose) {
    console.log('\n=== 详细信息 ===');
    console.log(`分类类型: ${decision.classification.type}`);
    console.log(`置信度: ${(decision.classification.confidence * 100).toFixed(1)}%`);
    console.log(`理由: ${decision.classification.reasoning}`);
    console.log(`目标模块: ${decision.targetModule}`);
    console.log(`是否强制路由: ${decision.isForced}`);
    if (decision.matchedRule) {
      console.log(`命中规则: ${decision.matchedRule.name}`);
    }
    console.log(`关键特征: ${decision.metadata.keyFeatures.join(', ') || '无'}`);
    console.log(`备选目标: ${decision.metadata.alternativeTargets.join(', ') || '无'}`);
  }

  console.log('\n=== 测试完成 ===\n');
  process.exit(0);
}

// 交互式测试模式
async function interactiveTest(): Promise<void> {
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const agent = new RouterChatAgent();
  const hub = new MessageHub();
  const sessionManager = new IflowSessionManager();
  
  await sessionManager.initialize();
  await agent.initializeHub(hub, sessionManager);

  console.log('\n=== Router Agent 交互式测试 ===');
  console.log('输入文本进行路由测试，输入 "exit" 退出\n');

  const prompt = (question: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(question, resolve);
    });
  };

  for (;;) {
    const text = await prompt('> ');
    
    if (text.toLowerCase() === 'exit' || text.toLowerCase() === 'quit') {
      console.log('退出交互模式');
      rl.close();
      process.exit(0);
    }

    if (!text.trim()) continue;

    const input = {
      text,
      sessionId: 'interactive-test',
      sender: { id: 'test-user', name: 'Test User' },
    };

    try {
      const decision = await agent['analyzeAndDecide'](input);
      
      console.log(`\n分类: ${decision.classification.type} (${(decision.classification.confidence * 100).toFixed(1)}%)`);
      console.log(`目标: ${decision.targetModule}`);
      console.log(`理由: ${decision.classification.reasoning}\n`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`错误: ${err.message}\n`);
    }
  }
}

// 正常启动模式
class RouterChatAgentCLI extends AgentCLIBase {
  private agent: RouterChatAgent | null = null;

  constructor() {
    const config: Partial<AgentCLIConfig> & { agentId: string; agentName: string } = {
      agentId: process.env.AGENT_ID || 'router-chat-agent',
      agentName: process.env.AGENT_NAME || 'Router Chat Agent',
      daemonUrl: process.env.DAEMON_URL || 'http://localhost:5521',
      heartbeatTimeoutMs: parseInt(process.env.HEARTBEAT_TIMEOUT_MS || '60000', 10),
      capabilities: ['routing', 'chat', 'intent-classification', 'semantic-understanding', 'session-management'],
    };
    super(config);
  }

  protected async initialize(): Promise<void> {
    log.info('Initializing RouterChatAgent...');

    this.hub = new MessageHub();
    this.agent = new RouterChatAgent();
    
    const sessionManager = new IflowSessionManager();
    await sessionManager.initialize();
    await this.agent.initializeHub(this.hub, sessionManager);
  }

  protected async runLoop(): Promise<void> {
    log.info('RouterChatAgent CLI entering main loop...');


    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (!this.getIsRunning()) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 1000);
    });
  }

  protected async cleanup(): Promise<void> {
    log.info('Cleaning up RouterChatAgent...');
    if (this.agent) {
      await this.agent.destroyAgent();
      this.agent = null;
    }
  }
}

// CLI 入口
const program = new Command();

program
  .name('router-chat-cli')
  .description('Router Chat Agent CLI')
  .version('1.0.0');

program
  .command('start')
  .description('Start the agent daemon')
  .option('--daemon-url <url>', 'Daemon URL', 'http://localhost:5521')
  .action(async (options) => {
    process.env.DAEMON_URL = options.daemonUrl;
    const cli = new RouterChatAgentCLI();
    await cli.start();
  });

program
  .command('dryrun')
  .description('Dryrun test - show routing decision without actual routing')
  .argument('<text>', 'Text to analyze')
  .option('-v, --verbose', 'Show detailed output', false)
  .action(async (text, options) => {
    await dryrunTest(text, options.verbose);
  });

program
  .command('interactive')
  .description('Interactive test mode')
  .action(async () => {
    await interactiveTest();
  });

program.parse();
