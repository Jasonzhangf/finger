#!/usr/bin/env node
/**
 * RouterChatAgent 真实测试脚本
 * 
 * 不使用 mock，真实启动 Agent 并测试路由逻辑
 */

import { RouterChatAgent } from '../src/agents/router-chat/router-chat-agent.js';
import { MessageHub } from '../src/orchestration/message-hub.js';
import { IflowSessionManager } from '../src/agents/chat/iflow-session-manager.js';
import { logger } from '../src/core/logger.js';

const log = logger.module('RouterRealTest');

interface TestCase {
  name: string;
  input: string;
  expectedType?: string;
}

const testCases: TestCase[] = [
  { name: '通用知识问题', input: '什么是 TypeScript?', expectedType: 'chat' },
  { name: '代码解释', input: '解释一下这段代码的作用', expectedType: 'chat' },
  { name: '创建任务', input: '帮我创建一个 React 组件', expectedType: 'task.execute' },
  { name: '文件操作', input: '读取这个文件的内容', expectedType: 'task.execute' },
  { name: '研究搜索', input: '搜索最新的 AI 技术', expectedType: 'research' },
  { name: '系统命令', input: '/sys status', expectedType: 'forced' },
  { name: '聊天问候', input: '你好，今天怎么样？', expectedType: 'chat' },
  { name: '代码修复', input: '修复这个 bug', expectedType: 'task.execute' },
];

async function runRealTest(): Promise<void> {
  console.log('\n========================================');
  console.log('   RouterChatAgent 真实测试');
  console.log('========================================\n');

  // 1. 真实启动依赖
  console.log('1. 初始化 MessageHub...');
  const hub = new MessageHub();
  
  console.log('2. 初始化 SessionManager...');
  const sessionManager = new IflowSessionManager();
  await sessionManager.initialize();
  
  console.log('3. 创建 RouterChatAgent...');
  const agent = new RouterChatAgent();
  
  console.log('4. 初始化 Agent...');
  await agent.initializeHub(hub, sessionManager);
  console.log('✅ Agent 初始化完成\n');

  // 2. 运行测试用例
  console.log('========================================');
  console.log('   开始路由测试');
  console.log('========================================\n');

  let passed = 0;
  let failed = 0;

  for (const testCase of testCases) {
    console.log(`\n测试: ${testCase.name}`);
    console.log(`输入: "${testCase.input}"`);
    
    try {
      // 使用 analyzeAndDecide 获取真实路由决策
      const input = {
        text: testCase.input,
        sessionId: 'test-session',
        sender: { id: 'test-user', name: 'Test User' },
      };

      // @ts-ignore - 访问私有方法
      const decision = await agent.analyzeAndDecide(input);

      console.log('├─ 分类类型:', decision.classification.type);
      console.log('├─ 置信度:', `${(decision.classification.confidence * 100).toFixed(1)}%`);
      console.log('├─ 目标模块:', decision.targetModule);
      console.log('├─ 理由:', decision.classification.reasoning);
      console.log('├─ 是否强制:', decision.isForced ? '是' : '否');
      console.log('└─ 关键特征:', decision.metadata.keyFeatures.join(', ') || '无');

      // 验证预期
      if (testCase.expectedType) {
        const match = decision.classification.type === testCase.expectedType ||
                     (testCase.expectedType === 'forced' && decision.isForced) ||
                     (testCase.expectedType === 'task.execute' && decision.classification.type.includes('task'));
        
        if (match) {
          console.log('✅ 符合预期');
          passed++;
        } else {
          console.log(`⚠️  不符合预期 (期望: ${testCase.expectedType})`);
          failed++;
        }
      } else {
        passed++;
      }

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.log('❌ 错误:', err.message);
      failed++;
    }
  }

  // 3. 测试会话管理
  console.log('\n========================================');
  console.log('   会话管理测试');
  console.log('========================================\n');

  console.log('测试: 创建多个 Agent Context');
  
  // @ts-ignore
  const chatContext = await agent.ensureAgentContext('chat', 'Chat Session', '通用聊天');
  console.log('✅ Chat Context:', chatContext.sessionId);
  
  // @ts-ignore
  const taskContext = await agent.ensureAgentContext('task-orchestrator', 'Task Orchestrator', '任务执行');
  console.log('✅ Task Context:', taskContext.sessionId);
  
  // @ts-ignore
  const allContexts = agent.getAllAgentContexts();
  console.log(`✅ 总 Context 数: ${allContexts.length}`);

  // 4. 清理
  console.log('\n========================================');
  console.log('   清理资源');
  console.log('========================================\n');
  
  await agent.destroyAgent();
  console.log('✅ Agent 已销毁');
  
  await sessionManager.destroy();
  console.log('✅ SessionManager 已销毁');

  // 5. 总结
  console.log('\n========================================');
  console.log('   测试总结');
  console.log('========================================');
  console.log(`总测试数: ${testCases.length}`);
  console.log(`通过: ${passed}`);
  console.log(`失败: ${failed}`);
  console.log(`成功率: ${((passed / testCases.length) * 100).toFixed(1)}%`);
  console.log('========================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

// 运行测试
runRealTest().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
