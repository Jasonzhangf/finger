/**
 * 基础输入输出测试场景
 * 验证用户输入能正确发送并在对话面板显示
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestAPI, createTestRunner } from '../index.js';
import type { TestScenario } from '../index.js';

describe('Basic Input/Output Flow', () => {
  const api = createTestAPI();
  const runner = createTestRunner();

  // Skip integration tests if server is not running
  const isServerRunning = process.env.VITEST_SERVER_RUNNING === 'true';

  beforeAll(async () => {
    if (!isServerRunning) {
      console.warn('Skipping integration tests: server not running. Set VITEST_SERVER_RUNNING=true to enable.');
      return;
    }
    await api.startServer();
    await api.resetState();
  });

  afterAll(async () => {
    if (!isServerRunning) return;
    await api.stopServer();
  });

 it('should send user input and receive agent response', async () => {
    if (!isServerRunning) {
      console.warn('Skipping test: server not running');
      return;
    }
    const scenario: TestScenario = {
      name: 'basic-input-output',
      steps: [
        {
          action: 'sendInput',
          params: { text: '搜索deepseek最新发布' },
        },
        {
          action: 'waitForResponse',
          params: { timeout: 30000 },
        },
      ],
      expectations: [
        {
          type: 'workflowStatus',
          expectedValue: 'running',
          timeoutMs: 5000,
        },
      ],
    };

    const result = await runner.runTestScenario(scenario);
    expect(result.passed).toBe(true);
    expect(result.steps.length).toBe(2);
    expect(result.steps[0].passed).toBe(true);
    expect(result.steps[1].passed).toBe(true);
  }, 60000);

 it('should maintain conversation history across multiple rounds', async () => {
    if (!isServerRunning) {
      console.warn('Skipping test: server not running');
      return;
    }
    // 第一轮对话
    await api.sendUserInput('第一轮任务');
    await api.waitForAgentResponse(10000);

    // 第二轮对话
    await api.sendUserInput('第二轮任务');
    const events = await api.waitForAgentResponse(10000);

    expect(events.length).toBeGreaterThan(0);
  }, 30000);
});
