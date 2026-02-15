import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IFlowSDKWrapper, IFlowAgentState, TaskExecutionResult } from '../../../src/agents/providers/iflow-sdk-wrapper.js';

/**
 * iFlow SDK Wrapper 基础能力测试
 * 注意：真实业务联调需要设置 RUN_INTEGRATION=true 并启动 iFlow 服务
 */
describe('IFlowSDKWrapper', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('基础接口验证', () => {
    it('creates wrapper with default config', () => {
      const wrapper = new IFlowSDKWrapper();
      const state = wrapper.getState();

      expect(state.connected).toBe(false);
      expect(state.executing).toBe(false);
      expect(state.sessionId).toBe('');
      expect(state.availableTools).toEqual([]);
      expect(state.availableCommands).toEqual([]);
      expect(state.availableAgents).toEqual([]);
    });

    it('creates wrapper with custom config', () => {
      const wrapper = new IFlowSDKWrapper({
        url: 'http://custom:8080',
        permissionMode: 'manual',
      });

      const state = wrapper.getState();
      expect(state.connected).toBe(false);
    });

    it('returns state copy', () => {
      const wrapper = new IFlowSDKWrapper();
      const state1 = wrapper.getState();
      const state2 = wrapper.getState();

      expect(state1).not.toBe(state2);
      expect(state1).toEqual(state2);
    });

    it('returns empty arrays for getters', () => {
      const wrapper = new IFlowSDKWrapper();

      expect(wrapper.getAvailableTools()).toEqual([]);
      expect(wrapper.getAvailableCommands()).toEqual([]);
      expect(wrapper.getAvailableAgents()).toEqual([]);

      // 修改返回值不影响内部状态
      const tools1 = wrapper.getAvailableTools();
      const tools2 = wrapper.getAvailableTools();
      expect(tools1).not.toBe(tools2);
    });

    it('throws when executing task while already executing', async () => {
      const wrapper = new IFlowSDKWrapper();

      // Mock fetch for connect
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ sessionId: 'test-session' }),
      });

      // 阻止实际初始化
      const initSpy = vi.spyOn(wrapper, 'initialize').mockResolvedValue({
        sessionId: '',
        connected: true,
        executing: false,
        availableCommands: [],
        availableAgents: [],
        availableTools: [],
      });

      // 直接设置内部状态为 executing
      (wrapper as unknown as { state: IFlowAgentState }).state.executing = true;

      await expect(wrapper.executeTask('task-1', 'test prompt')).rejects.toThrow(
        'Another task is already executing'
      );

      initSpy.mockRestore();
    });
  });

  describe('真实业务联调测试', () => {
    // 仅在 RUN_INTEGRATION=true 时运行
    const runIntegration = process.env.RUN_INTEGRATION === 'true';
    const iflowUrl = process.env.IFLOW_URL || 'http://127.0.0.1:5520';

    (runIntegration ? it : it.skip)('connects to real iFlow server', async () => {
      const wrapper = new IFlowSDKWrapper({
        url: iflowUrl,
        autoStartProcess: false, // 需要预先启动服务
      });

      const state = await wrapper.initialize();

      expect(state.connected).toBe(true);
      expect(state.sessionId).toBeTruthy();

      await wrapper.disconnect();
      expect(wrapper.getState().connected).toBe(false);
    }, 10000);

    (runIntegration ? it : it.skip)('executes simple task', async () => {
      const wrapper = new IFlowSDKWrapper({
        url: iflowUrl,
        autoStartProcess: false,
        permissionMode: 'auto',
      });

      await wrapper.initialize();

      const result = await wrapper.executeTask(
        'test-task-1',
        '输出 hello world'
      );

      expect(result.taskId).toBe('test-task-1');
      expect(result.output).toBeTruthy();

      await wrapper.disconnect();
    }, 30000);

    (runIntegration ? it : it.skip)('gets available tools', async () => {
      const wrapper = new IFlowSDKWrapper({
        url: iflowUrl,
        autoStartProcess: false,
      });

      await wrapper.initialize();

      const tools = wrapper.getAvailableTools();
      console.log('Available tools:', tools);

      // 至少应该有一些基础工具
      expect(Array.isArray(tools)).toBe(true);

      await wrapper.disconnect();
    }, 10000);

    (runIntegration ? it : it.skip)('handles tool calls', async () => {
      const wrapper = new IFlowSDKWrapper({
        url: iflowUrl,
        autoStartProcess: false,
        permissionMode: 'auto',
      });

      await wrapper.initialize();

      const result = await wrapper.executeTask(
        'tool-test',
        '列出当前目录的文件'
      );

      expect(result.toolCalls).toBeDefined();
      expect(Array.isArray(result.toolCalls)).toBe(true);

      console.log('Tool calls:', result.toolCalls);

      await wrapper.disconnect();
    }, 30000);
  });
});
