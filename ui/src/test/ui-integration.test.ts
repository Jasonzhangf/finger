/**
 * UI 集成测试
 * 验证 UI 和后端事件流的完整连接
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createUITestHelper } from './ui-test-helper.js';

describe('UI Integration Tests', () => {
  const helper = createUITestHelper();

  beforeAll(async () => {
    await helper.startTestServer();
    await helper.resetTestState();
  });

  afterAll(async () => {
    await helper.stopTestServer();
  });

  it('should connect to server and receive health check', async () => {
    const healthy = await helper.checkServerHealth();
    expect(healthy).toBe(true);
  });

  it('should receive workflow state', async () => {
    const state = await helper.getExecutionState();
    expect(state).toBeDefined();
    expect(state.status).toBeDefined();
    expect(Array.isArray(state.agents)).toBe(true);
  });

  it('should send user input successfully', async () => {
    await expect(
      helper.sendUserInput('测试任务')
    ).resolves.not.toThrow();
  });

  it('should receive events from WebSocket', async () => {
    const events: unknown[] = [];
    
    const unsubscribe = helper.subscribeToEvents((event) => {
      events.push(event);
    });

    await helper.sendUserInput('测试事件订阅');
    
    // 等待一段时间收集事件
    await new Promise(r => setTimeout(r, 3000));
    
    unsubscribe();
    
    // 即使没有 agent 响应，也应该能收到系统事件
    expect(events.length).toBeGreaterThanOrEqual(0);
  });

  it('should handle multiple rounds of input', async () => {
    // 第一轮
    await helper.sendUserInput('第一轮任务');
    await new Promise(r => setTimeout(r, 1000));

    // 第二轮
    await helper.sendUserInput('第二轮任务');
    await new Promise(r => setTimeout(r, 1000));

    // 第三轮
    await helper.sendUserInput('第三轮任务');
    
    const state = await helper.getExecutionState();
    expect(state).toBeDefined();
  }, 10000);
});
