/**
 * DeepSeek Research E2E Test - Full Phase Flow
 * 
 * Task: 搜索 DeepSeek 过去一年成果，下载论文，分析未集成技术，预测新模型功能
 * Output: 本地 deepseek 文件夹，包含每阶段过程文件和决策树，最终完整报告
 * 
 * Features:
 * - 真实 iFlow 连接
 * - 无超时限制
 * - 阶段事件实时广播 (WebSocket)
 * - Checkpoint 自动保存
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MessageHub } from '../../src/orchestration/message-hub.js';
import { createOrchestratorLoop } from '../../src/agents/daemon/orchestrator-loop.js';
import { createExecutorLoop } from '../../src/agents/daemon/executor-loop.js';
import { globalEventBus } from '../../src/runtime/event-bus.js';
import { IFlowClient, TransportMode } from '@iflow-ai/iflow-cli-sdk';
import fs from 'fs/promises';
import path from 'path';

// Output directory for this task
const TASK_OUTPUT_DIR = path.resolve('output/deepseek-research');

interface PhaseLog {
  phase: string;
  timestamp: string;
  action: string;
  checkpointId?: string;
  outputs?: string[];
}

interface DecisionTreeNode {
  phase: string;
  round: number;
  thought: string;
  action: string;
  params: Record<string, unknown>;
  observation?: string;
  timestamp: string;
}

describe('DeepSeek Research - Full Phase E2E', () => {
  let hub: MessageHub;
  let orchestratorModule: ReturnType<typeof createOrchestratorLoop>['module'];
  let executorModule: ReturnType<typeof createExecutorLoop>['module'];
  let iflowClient: IFlowClient;
  const phaseLogs: PhaseLog[] = [];
  const decisionTree: DecisionTreeNode[] = [];
  
  // Track phase transitions via WebSocket events
  const eventSubscriptions: Array<() => void> = [];

  beforeAll(async () => {
    // 1. Create output directories
    const phases = ['understanding', 'high_design', 'detail_design', 'deliverables', 'plan', 'parallel_dispatch', 'blocked_review', 'verify'];
    for (const phase of phases) {
      await fs.mkdir(path.join(TASK_OUTPUT_DIR, phase), { recursive: true });
    }

    // 2. Setup iFlow client (auto-managed process)
    console.log('[Setup] Initializing iFlow client...');
    iflowClient = new IFlowClient({
      url: 'ws://localhost:8090/acp',
      cwd: TASK_OUTPUT_DIR,
      autoStartProcess: true,
      processStartPort: 8090,
      transportMode: TransportMode.WEBSOCKET,
      sessionSettings: {
        system_prompt: `你是一个专业的 AI 技术调研专家。
任务：调研 DeepSeek 过去一年的技术发布，下载关键论文，分析未集成到产品的技术路线，预测下一个模型功能。
要求：
1. 使用 web_search 搜索 DeepSeek 官方发布
2. 下载技术白皮书和论文
3. 分析技术演进趋势
4. 预测下一代模型特性
5. 输出完整报告到指定目录`,
        allowed_tools: ['web_search', 'read_file', 'write_file', 'execute_command', 'fetch_url'],
        max_turns: 100,
      },
      permissionMode: 'auto',
    });

    await iflowClient.connect();
    console.log(`[Setup] iFlow connected, session: ${iflowClient.getSessionId()}`);

    // 3. Subscribe to phase events for real-time logging
    const unsubPhase = globalEventBus.subscribe('phase_transition', (event) => {
      console.log(`[Phase] ${event.payload?.from} → ${event.payload?.to}`);
      phaseLogs.push({
        phase: event.payload?.to as string,
        timestamp: event.timestamp,
        action: 'transition',
        checkpointId: event.payload?.checkpointId as string,
      });
    });
    eventSubscriptions.push(unsubPhase);

    const unsubDecision = globalEventBus.subscribe('decision_tree_node', (event) => {
      console.log(`[Decision] ${event.payload?.phase} R${event.payload?.round}: ${event.payload?.action}`);
      decisionTree.push({
        phase: event.payload?.phase as string,
        round: event.payload?.round as number,
        thought: event.payload?.thought as string,
        action: event.payload?.action as string,
        params: event.payload?.params as Record<string, unknown>,
        observation: event.payload?.observation as string,
        timestamp: event.timestamp,
      });
    });
    eventSubscriptions.push(unsubDecision);

    // 4. Setup MessageHub and modules
    hub = new MessageHub();

    const { module: orchModule } = createOrchestratorLoop({
      id: 'deepseek-orchestrator',
      name: 'DeepSeek Research Orchestrator',
      mode: 'auto',
      maxRounds: 50,
      cwd: TASK_OUTPUT_DIR,
      sessionId: `deepseek-research-${Date.now()}`,
    }, hub);
    orchestratorModule = orchModule;
    await orchestratorModule.initialize?.();

    const { module: execModule } = createExecutorLoop({
      id: 'deepseek-executor',
      name: 'DeepSeek Research Executor',
      mode: 'auto',
      maxIterations: 50,
      cwd: TASK_OUTPUT_DIR,
    });
    executorModule = execModule;
    await executorModule.initialize?.();

    hub.registerOutput('deepseek-orchestrator', async (msg, cb) => {
      const result = await orchestratorModule.handle(msg, cb);
      return result;
    });

    hub.registerOutput('deepseek-executor', async (msg, cb) => {
      const result = await executorModule.handle(msg, cb);
      return result;
    });

    console.log('[Setup] All modules initialized');
  }, 120000);

  afterAll(async () => {
    // Cleanup
    eventSubscriptions.forEach(unsub => unsub());
    
    // Save phase logs and decision tree
    await fs.writeFile(
      path.join(TASK_OUTPUT_DIR, 'phase-logs.json'),
      JSON.stringify(phaseLogs, null, 2)
    );
    await fs.writeFile(
      path.join(TASK_OUTPUT_DIR, 'decision-tree.json'),
      JSON.stringify(decisionTree, null, 2)
    );

    await orchestratorModule.destroy?.();
    await executorModule.destroy?.();
    await iflowClient.disconnect();
    
    console.log('[Teardown] Cleanup complete');
  });

  it('completes full phase flow for DeepSeek research', async () => {
    const taskDescription = `搜索 DeepSeek 过去一年中的成果发表，包括：
1. 访问官方网站和技术博客
2. 搜索 arXiv、GitHub 等平台上的 DeepSeek 论文和发布
3. 下载关键的技术白皮书和研究论文
4. 分析 DeepSeek 已发表但尚未集成到产品的技术路线
5. 基于技术演进趋势，预测下一个模型发布的功能特性
6. 将所有研究成果保存在 ${TASK_OUTPUT_DIR} 目录
7. 每个阶段产生过程文件和决策日志
8. 最终交付完整的技术分析报告`;

    console.log('[Test] Starting task...');
    console.log(`[Test] Output directory: ${TASK_OUTPUT_DIR}`);

    const result = await hub.sendToModule('deepseek-orchestrator', {
      content: taskDescription,
    }) as {
      success: boolean;
      result?: {
        success: boolean;
        epicId: string;
        completed?: number;
        failed?: number;
        rounds: number;
      };
      error?: string;
    };

    console.log('[Test] Task completed');
    console.log(JSON.stringify(result, null, 2));

    // Assertions
    expect(result.success).toBe(true);
    
    if (result.result) {
      expect(result.result.failed).toBe(0);
      expect(result.result.rounds).toBeGreaterThan(0);
    }

    // Verify output files exist
    const outputFiles = await fs.readdir(TASK_OUTPUT_DIR);
    console.log(`[Test] Output files: ${outputFiles.join(', ')}`);
    
    // At minimum, phase logs should be created
    expect(outputFiles.length).toBeGreaterThan(0);
    
  }, 0); // 0 = no timeout
});
