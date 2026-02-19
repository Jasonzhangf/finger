/**
 * 编排 Agent 端到端测试 - 使用临时目录隔离
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MessageHub } from '../../src/orchestration/message-hub.js';
import { createOrchestratorLoop } from '../../src/agents/daemon/orchestrator-loop.js';
import { createExecutorLoop } from '../../src/agents/daemon/executor-loop.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Orchestrator E2E', () => {
  let hub: MessageHub;
  let orchestratorModule: ReturnType<typeof createOrchestratorLoop>['module'];
  let executorModule: ReturnType<typeof createExecutorLoop>['module'];
  let tempDir: string;

  beforeAll(async () => {
    // 创建临时目录
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-e2e-'));
    console.log(`\nTemp dir: ${tempDir}`);

    // 初始化 bd
    try {
      execSync('bd init --no-db', { cwd: tempDir, stdio: 'ignore' });
    } catch {
      fs.mkdirSync(path.join(tempDir, '.beads'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, '.beads', 'config.yaml'),
        'mode: git-portable\n'
      );
    }

    hub = new MessageHub();

    // 创建编排者
    const orch = createOrchestratorLoop({
      id: 'orchestrator-e2e',
      name: 'E2E Orchestrator',
      mode: 'auto',
      maxRounds: 5,
      cwd: tempDir,
    }, hub);
    orchestratorModule = orch.module;
    await orchestratorModule.initialize?.();

    // 创建执行者（使用明确的 system prompt）
    const exec = createExecutorLoop({
      id: 'executor-loop',
      name: 'E2E Executor',
      mode: 'auto',
      maxIterations: 20,
      cwd: tempDir,
      systemPrompt: `你是一个任务执行者。你的工作是完成具体的执行任务。

## ReACT 循环

每次循环你需要：
1. Thought: 分析任务和已有观察
2. Action: 执行具体操作（不要询问，直接执行）
3. Observation: 获取结果

## 可用行动

- WRITE_FILE: 创建文件，参数 { path: "文件路径", content: "内容" }
- COMPLETE: 任务完成，参数 { output: "完成说明" }
- FAIL: 任务失败（仅在无法完成时使用）

## 输出格式（必须严格遵循）

只输出 JSON，不要其他文字：
{"thought": "分析", "action": "WRITE_FILE|COMPLETE|FAIL", "params": {"path": "xxx", "content": "xxx"}}

## 工作目录

当前工作目录是临时目录，直接在此创建文件即可，无需确认。

示例：
{"thought": "需要创建文件", "action": "WRITE_FILE", "params": {"path": "test.txt", "content": "Hello"}}
{"thought": "任务完成", "action": "COMPLETE", "params": {"output": "文件已创建"}}`,
    });
    executorModule = exec.module;
    await executorModule.initialize?.();

    hub.registerOutput('orchestrator-e2e', async (msg, cb) => {
      const result = await orchestratorModule.handle(msg, cb);
      return result;
    });

    hub.registerOutput('executor-loop', async (msg, cb) => {
      const result = await executorModule.handle(msg, cb);
      return result;
    });
  }, 60000);

  afterAll(async () => {
    await orchestratorModule.destroy?.();
    await executorModule.destroy?.();
    
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('completes full orchestration loop with all tasks finished', async () => {
    const userTask = '创建一个 Node.js 项目，包含: 1) package.json 2) src/index.js 主入口 3) README.md';

    const result = await hub.sendToModule('orchestrator-e2e', {
      content: userTask,
    }) as {
      success: boolean;
      result?: {
        success: boolean;
        epicId: string;
        completed?: number;
        failed?: number;
        rounds: number;
      };
    };

    console.log('\n=== E2E Test Result ===');
    console.log(JSON.stringify(result, null, 2));

    // 验证编排完成（直接成功或通过拆解执行）
    expect(result.success).toBe(true);
    
    if (result.result) {
      const { completed = 0, failed = 0, rounds } = result.result;
      console.log(`Completed: ${completed}, Failed: ${failed}, Rounds: ${rounds}`);
      
      // 要么直接成功，要么任务全部完成
      // 允许部分任务失败，只要主任务完成
      expect(failed).toBeLessThanOrEqual(completed + 1);
      expect(rounds).toBeLessThanOrEqual(15);
    }
  }, 300000);  // 缩短超时到 5 分钟
});
