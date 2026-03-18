/**
 * AgentStatusSubscriber 单元测试
 *
 * 验证分层订阅策略：
 * - detailed 订阅：订阅所有状态变化
 * - summary 订阅：只订阅关键状态变化
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RuntimeEvent } from '../../../src/runtime/events';
import { AgentStatusSubscriber, SubscriptionLevel } from '../../../src/server/modules/agent-status-subscriber';
import { UnifiedEventBus } from '../../../src/runtime/event-bus';

describe('AgentStatusSubscriber', () => {
  let eventBus: UnifiedEventBus;
  let subscriber: AgentStatusSubscriber;

  // Mock AgentRuntimeDeps
  const mockSessionManager = {
    getSession: vi.fn(),
  };

  const mockAgentRuntimeDeps = {
    sessionManager: mockSessionManager,
    agentRuntimeBlock: {
      execute: vi.fn().mockResolvedValue({
        agents: [
          {
            id: 'agent-1',
            name: 'Test Agent 1',
            type: 'executor',
          },
          {
            id: 'agent-2',
            name: 'Test Agent 2',
            type: 'orchestrator',
          },
        ],
      }),
    },
  } as any;

  beforeEach(() => {
    eventBus = new UnifiedEventBus();
    subscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps);
    mockSessionManager.getSession.mockReturnValue(null);
  });

  afterEach(() => {
    subscriber.stop();
  });

  describe('分层订阅策略', () => {
    it('应该支持 detailed 订阅级别', async () => {
      // Mock MessageHub
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };

      const detailedSubscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      detailedSubscriber.setPrimaryAgent('agent-1');
      detailedSubscriber.registerSession('session-1', {
        channel: 'qqbot',
        envelopeId: 'env-1',
      });
      detailedSubscriber.start();

      // 发送 running 状态事件（非关键状态）
      const event: RuntimeEvent = {
        type: 'agent_runtime_status',
        sessionId: 'session-1',
        timestamp: new Date().toISOString(),
        payload: {
          scope: 'global',
          status: 'running',
          agentId: 'agent-1',
          summary: 'Task is running',
        },
      };

      // 触发事件
      await eventBus.emit(event);

      // 等待异步处理
      await new Promise(resolve => setTimeout(resolve, 100));

      // detailed 订阅应该接收所有状态（包括非关键状态）
      expect(mockMessageHub.routeToOutput).toHaveBeenCalled();
      expect(mockMessageHub.routeToOutput).toHaveBeenCalledWith(
        'channel-bridge-qqbot',
        expect.objectContaining({
          channelId: 'qqbot',
          envelopeId: 'env-1',
          statusUpdate: expect.objectContaining({
            agent: expect.objectContaining({
              agentId: 'agent-1',
            }),
            status: expect.objectContaining({
              state: 'running',
            }),
            display: expect.objectContaining({
              level: 'detailed',
            }),
          }),
        })
      );

      detailedSubscriber.stop();
    });

    it('应该支持 summary 订阅级别', async () => {
      // Mock MessageHub
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };

      const summarySubscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      summarySubscriber.registerChildAgent('agent-2', 'agent-1');
      summarySubscriber.registerSession('session-2', {
        channel: 'qqbot',
        envelopeId: 'env-2',
      });
      summarySubscriber.start();

      // 发送 running 状态事件（非关键状态）
      const runningEvent: RuntimeEvent = {
        type: 'agent_runtime_status',
        sessionId: 'session-2',
        timestamp: new Date().toISOString(),
        payload: {
          scope: 'global',
          status: 'running',
          agentId: 'agent-2',
          summary: 'Task is running',
        },
      };

      // 触发 running 事件
      await eventBus.emit(runningEvent);
      await new Promise(resolve => setTimeout(resolve, 100));

      // summary 订阅应该跳过非关键状态
      expect(mockMessageHub.routeToOutput).not.toHaveBeenCalled();

      // 发送 completed 状态事件（关键状态）
      const completedEvent: RuntimeEvent = {
        type: 'agent_runtime_status',
        sessionId: 'session-2',
        timestamp: new Date().toISOString(),
        payload: {
          scope: 'global',
          status: 'completed',
          agentId: 'agent-2',
          summary: 'Task completed',
        },
      };

      // 触发 completed 事件
      await eventBus.emit(completedEvent);
      await new Promise(resolve => setTimeout(resolve, 100));

      // summary 订阅应该接收关键状态
      expect(mockMessageHub.routeToOutput).toHaveBeenCalled();
      expect(mockMessageHub.routeToOutput).toHaveBeenCalledWith(
        'channel-bridge-qqbot',
        expect.objectContaining({
          channelId: 'qqbot',
          envelopeId: 'env-2',
          statusUpdate: expect.objectContaining({
            agent: expect.objectContaining({
              agentId: 'agent-2',
            }),
            status: expect.objectContaining({
              state: 'completed',
            }),
            display: expect.objectContaining({
              level: 'summary',
            }),
          }),
        })
      );

      summarySubscriber.stop();
    });

    it('应该正确包装状态更新事件', async () => {
      // Mock MessageHub
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };

      const packageSubscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      packageSubscriber.setPrimaryAgent('agent-1');
      packageSubscriber.registerSession('session-3', {
        channel: 'qqbot',
        envelopeId: 'env-3',
        userId: 'user-package',
        groupId: 'group-package',
      });
      packageSubscriber.start();

      const event: RuntimeEvent = {
        type: 'agent_runtime_status',
        sessionId: 'session-3',
        timestamp: '2026-03-18T10:00:00.000Z',
        payload: {
          scope: 'global',
          status: 'running',
          agentId: 'agent-1',
          summary: 'Processing task',
        },
      };

      // 触发事件
      await eventBus.emit(event);
      await new Promise(resolve => setTimeout(resolve, 100));

      // 验证包装后的状态更新包含正确的字段
      expect(mockMessageHub.routeToOutput).toHaveBeenCalled();
      
      // 捕获传递给 routeToOutput 的参数
      const callArgs = mockMessageHub.routeToOutput.mock.calls[0];
      expect(callArgs).toHaveLength(2); // [outputId, message]
      const outputId = callArgs[0];
      const message = callArgs[1];

      // 断言 output id
      expect(outputId).toBe('channel-bridge-qqbot');

      // 断言 message 结构
      expect(message).toMatchObject({
        channelId: 'qqbot',
        envelopeId: 'env-3',
        userId: 'user-package',
        groupId: 'group-package',
      });

      // 断言 statusUpdate 字段
      expect(message.statusUpdate).toMatchObject({
        type: 'agent_status',
        eventId: expect.any(String),
        timestamp: '2026-03-18T10:00:00.000Z',
        sessionId: 'session-3',
      });

      // 断言 agent 信息
      expect(message.statusUpdate.agent).toMatchObject({
        agentId: 'agent-1',
        agentName: 'Test Agent 1',
        agentRole: 'executor',
      });

      // 断言 task 上下文
      expect(message.statusUpdate.task).toMatchObject({
        targetAgentId: 'agent-1',
        taskDescription: 'Processing task',
      });

      // 断言 status 信息
      expect(message.statusUpdate.status).toMatchObject({
        state: 'running',
        summary: 'Processing task',
      });

      // 断言 display 信息
      expect(message.statusUpdate.display).toMatchObject({
        title: expect.stringContaining('Test Agent 1'),
        subtitle: 'Processing task',
        icon: expect.any(String),
        level: 'detailed',
      });

      packageSubscriber.stop();
    });

    it('应该回退 runtime 子会话到 root session 的 envelope 映射', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };

      const fallbackSubscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      fallbackSubscriber.setPrimaryAgent('agent-1');
      fallbackSubscriber.registerSession('root-session', {
        channel: 'qqbot',
        envelopeId: 'env-root',
      });

      mockSessionManager.getSession.mockImplementation((sessionId: string) => {
        if (sessionId === 'runtime-session') {
          return {
            id: sessionId,
            context: {
              rootSessionId: 'root-session',
              parentSessionId: 'root-session',
            },
          } as any;
        }
        return null;
      });

      fallbackSubscriber.start();

      const event: RuntimeEvent = {
        type: 'agent_runtime_status',
        sessionId: 'runtime-session',
        timestamp: new Date().toISOString(),
        payload: {
          scope: 'global',
          status: 'completed',
          agentId: 'agent-1',
          summary: 'Runtime task completed',
        },
      };

      await eventBus.emit(event);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockMessageHub.routeToOutput).toHaveBeenCalledWith(
        'channel-bridge-qqbot',
        expect.objectContaining({
          channelId: 'qqbot',
          envelopeId: 'env-root',
        })
      );

      fallbackSubscriber.stop();
    });
  });


    it('应该通过 messageHub 发送状态更新到 ChannelBridge', async () => {
      // Mock MessageHub
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };

      subscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      subscriber.setPrimaryAgent('agent-1');
      subscriber.registerSession('session-mock', {
        channel: 'qqbot',
        envelopeId: 'env-mock',
        userId: 'user-123',
        groupId: 'group-456',
      });
      subscriber.start();

      // 发送 completed 状态事件（detailed 订阅应该接收）
      const event: RuntimeEvent = {
        type: 'agent_runtime_status',
        sessionId: 'session-mock',
        timestamp: '2026-03-18T10:00:00.000Z',
        payload: {
          scope: 'global',
          status: 'completed',
          agentId: 'agent-1',
          summary: 'Task completed successfully',
        },
      };

      // 触发事件
      await eventBus.emit(event);

      // 等待异步处理
      await new Promise(resolve => setTimeout(resolve, 100));

      // 断言 messageHub.routeToOutput 被调用
      expect(mockMessageHub.routeToOutput).toHaveBeenCalled();

      // 断言 output id 是 channel-bridge-qqbot
      expect(mockMessageHub.routeToOutput).toHaveBeenCalledWith(
        'channel-bridge-qqbot',
        expect.objectContaining({
          channelId: 'qqbot',
          envelopeId: 'env-mock',
          userId: 'user-123',
          groupId: 'group-456',
          statusUpdate: expect.objectContaining({
            type: 'agent_status',
            agent: expect.objectContaining({
              agentId: 'agent-1',
            }),
            status: expect.objectContaining({
              state: 'completed',
            }),
          }),
        })
      );

      subscriber.stop();
    });

  describe('生命周期管理', () => {
    it('应该正确启动和停止订阅', () => {
      const consoleLogSpy = vi.spyOn(console, 'log');

      subscriber.start();
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Started'));

      subscriber.stop();
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Stopped'));

      consoleLogSpy.mockRestore();
    });
  });

  describe('定时器清理', () => {
    it('应该在停止时清理定时器', () => {
      subscriber.start();
      expect((subscriber as any).cleanupTimer).not.toBeNull();

      subscriber.stop();
      expect((subscriber as any).cleanupTimer).toBeNull();
    });
  });
});
