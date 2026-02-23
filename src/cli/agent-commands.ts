/**
 * Agent CLI Commands
 * 
 * 每个 Agent 阶段封装为独立 CLI 命令：
 * - finger understand: 语义理解
 * - finger route: 路由决策
 * - finger plan: 任务规划
 * - finger execute: 任务执行
 * - finger review: 质量审查
 * - finger orchestrate: 编排协调
 * 
 * 通过 MessageHub 和 WebSocket 进行通信
 */

import { MessageHub } from '../orchestration/message-hub.js';
import { globalEventBus } from '../runtime/event-bus.js';
import { getOrCreateWorkflowFSM } from '../orchestration/workflow-fsm.js';
import {
  buildUnderstandingPrompt,
  buildRouterPrompt,
  buildPlannerPrompt,
  buildExecutorPrompt,
  buildPreActReviewPrompt,
  buildOrchestratorPrompt,
} from '../agents/prompts/index.js';
import { Agent } from '../agents/agent.js';

const hub = new MessageHub();

// ========== Understand Command ==========
export async function understandCommand(input: string, options: { sessionId?: string } = {}): Promise<void> {
  console.log(`[CLI] Understanding: "${input}"`);

  const sessionId = options.sessionId || `session-${Date.now()}`;
  
  const understandingAgent = new Agent({
    id: 'understanding-cli',
    name: 'Understanding Agent',
    mode: 'auto',
    provider: 'iflow',
    systemPrompt: '',
  });

  await understandingAgent.initialize();

  const prompt = buildUnderstandingPrompt({
    rawInput: input,
    systemState: {
      workflowStatus: 'idle',
      lastActivity: new Date().toISOString(),
      availableResources: ['executor-general'],
    },
    recentHistory: [],
  });

  const result = await understandingAgent.execute(prompt);
  
  console.log('[CLI] Understanding result:');
  console.log(JSON.stringify(result, null, 2));

  await hub.sendToModule('router-cli', {
    type: 'intent_analysis',
    sessionId,
    intentAnalysis: result,
  });

  await understandingAgent.disconnect();
}

// ========== Route Command ==========
export async function routeCommand(intentAnalysis: string, options: { sessionId?: string } = {}): Promise<void> {
  console.log(`[CLI] Routing based on intent analysis`);

  const sessionId = options.sessionId || `session-${Date.now()}`;
  const intent = JSON.parse(intentAnalysis);

  const routerAgent = new Agent({
    id: 'router-cli',
    name: 'Router Agent',
    mode: 'auto',
    provider: 'iflow',
  });

  await routerAgent.initialize();

  const prompt = buildRouterPrompt({
    intentAnalysis: intent,
    systemState: {
      workflowStatus: 'idle',
      lastActivity: new Date().toISOString(),
      availableResources: ['executor-general'],
    },
  });

  const result = await routerAgent.execute(prompt);
  
  console.log('[CLI] Routing result:');
  console.log(JSON.stringify(result, null, 2));

  const fsm = getOrCreateWorkflowFSM({
    workflowId: `wf-${Date.now()}`,
    sessionId,
  });

  const route = (result as any).params?.route;
  if (route) {
    await fsm.trigger('routing_decided', {
      routingDecision: { route },
    });
  }

  await routerAgent.disconnect();
}

// ========== Plan Command ==========
export async function planCommand(task: string, options: { sessionId?: string } = {}): Promise<void> {
  console.log(`[CLI] Planning task: "${task}"`);

  const sessionId = options.sessionId || `session-${Date.now()}`;

  const plannerAgent = new Agent({
    id: 'planner-cli',
    name: 'Planner Agent',
    mode: 'auto',
    provider: 'iflow',
  });

  await plannerAgent.initialize();

  const prompt = buildPlannerPrompt({
    task,
    tools: [
      { name: 'WEB_SEARCH', description: '网络搜索', params: { query: 'string' } },
      { name: 'READ_FILE', description: '读取文件', params: { path: 'string' } },
      { name: 'WRITE_FILE', description: '写入文件', params: { path: 'string', content: 'string' } },
    ],
    history: '',
    round: 1,
  });

  const result = await plannerAgent.execute(prompt);
  
  console.log('[CLI] Planning result:');
  console.log(JSON.stringify(result, null, 2));

  await plannerAgent.disconnect();
}

// ========== Execute Command ==========
export async function executeCommand(task: string, options: { agent?: string; blocking?: boolean; sessionId?: string } = {}): Promise<void> {
  console.log(`[CLI] Executing task: "${task}"`);

  const agentId = options.agent || 'executor-general';

  const executorAgent = new Agent({
    id: 'executor-cli',
    name: 'Executor Agent',
    mode: options.blocking ? 'manual' : 'auto',
    provider: 'iflow',
  });

  await executorAgent.initialize();

  const prompt = buildExecutorPrompt({
    task: {
      id: `task-${Date.now()}`,
      description: task,
    },
    tools: [
      { name: 'WEB_SEARCH', description: '网络搜索', params: { query: 'string' } },
      { name: 'READ_FILE', description: '读取文件', params: { path: 'string' } },
      { name: 'WRITE_FILE', description: '写入文件', params: { path: 'string', content: 'string' } },
      { name: 'SHELL_EXEC', description: '执行 shell 命令', params: { command: 'string' } },
    ],
    round: 1,
  });

  const result = await executorAgent.execute(prompt);
  
  console.log('[CLI] Execution result:');
  console.log(JSON.stringify(result, null, 2));

  await executorAgent.disconnect();
}

// ========== Review Command ==========
export async function reviewCommand(proposal: string): Promise<void> {
  console.log(`[CLI] Reviewing proposal`);

  const proposalObj = JSON.parse(proposal);

  const reviewerAgent = new Agent({
    id: 'reviewer-cli',
    name: 'Reviewer Agent',
    mode: 'auto',
    provider: 'iflow',
  });

  await reviewerAgent.initialize();

  const prompt = buildPreActReviewPrompt({
    task: 'Review proposal',
    round: 1,
    proposal: proposalObj,
    availableTools: ['WEB_SEARCH', 'READ_FILE', 'WRITE_FILE'],
  });

  const result = await reviewerAgent.execute(prompt);
  
  console.log('[CLI] Review result:');
  console.log(JSON.stringify(result, null, 2));

  await reviewerAgent.disconnect();
}

// ========== Orchestrate Command ==========
export async function orchestrateCommand(task: string, options: { sessionId?: string; watch?: boolean; json?: boolean; stream?: boolean } = {}): Promise<void> {
  console.log(`[CLI] Orchestrating task: "${task}"`);

  const sessionId = options.sessionId || `session-${Date.now()}`;

  const orchestratorAgent = new Agent({
    id: 'orchestrator-cli',
    name: 'Orchestrator Agent',
    mode: 'auto',
    provider: 'iflow',
  });

  await orchestratorAgent.initialize();

  const prompt = buildOrchestratorPrompt({
    workflowStatus: 'idle',
    currentPhase: 'semantic_understanding',
    taskProgress: {
      total: 0,
      completed: 0,
      failed: 0,
      inProgress: 0,
      pending: 0,
    },
    resourceStatus: {
      available: 1,
      busy: 0,
      blocked: 0,
    },
    recentEvents: [],
  });

  const result = await orchestratorAgent.execute(prompt);
  
  console.log('[CLI] Orchestration result:');
  console.log(JSON.stringify(result, null, 2));

  if (options.watch) {
    console.log('[CLI] Watching for events...');
    
    globalEventBus.subscribe('phase_transition', (event) => {
      console.log('[CLI] Phase transition:', event.payload);
    });

    globalEventBus.subscribe('task_started', (event) => {
      console.log('[CLI] Task started:', event.payload);
    });

    globalEventBus.subscribe('task_completed', (event) => {
      console.log('[CLI] Task completed:', event.payload);
    });

    await new Promise(() => {});
  }

  await orchestratorAgent.disconnect();
}
