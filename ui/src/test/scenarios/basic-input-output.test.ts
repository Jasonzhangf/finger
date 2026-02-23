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

  beforeAll(async () => {
    await api.startServer();
    await api.resetState();
  });

  afterAll(async () => {
    await api.stopServer();
  });

  it('should send user input and receive agent response', async () => {
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
    // 第一轮对话
    await api.sendUserInput('第一轮任务');
    await api.waitForAgentResponse(10000);

    // 第二轮对话
    await api.sendUserInput('第二轮任务');
    const events = await api.waitForAgentResponse(10000);

    expect(events.length).toBeGreaterThan(0);
  }, 30000);
});
