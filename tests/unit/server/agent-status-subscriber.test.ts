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
import { heartbeatMailbox } from '../../../src/server/modules/heartbeat-mailbox';

describe('AgentStatusSubscriber', () => {
  let eventBus: UnifiedEventBus;
  let subscriber: AgentStatusSubscriber;

  // Mock AgentRuntimeDeps
  const mockSessionManager = {
    getSession: vi.fn(),
    updateContext: vi.fn(),
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
    mockSessionManager.updateContext.mockReset();
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
          target: 'unknown',
          content: expect.any(String),
          originalEnvelope: expect.objectContaining({
            channelId: 'qqbot',
            metadata: expect.objectContaining({
              messageId: 'env-1',
            }),
          }),
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
          target: 'unknown',
          content: expect.any(String),
          originalEnvelope: expect.objectContaining({
            channelId: 'qqbot',
            metadata: expect.objectContaining({
              messageId: 'env-2',
            }),
          }),
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
        target: 'group:group-package',
        content: expect.any(String),
        originalEnvelope: expect.objectContaining({
          channelId: 'qqbot',
          senderId: 'user-package',
          metadata: expect.objectContaining({
            messageId: 'env-3',
            groupId: 'group-package',
          }),
        }),
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

    it('应该把 dispatch 事件推送到通道（用于 QQBot 派发进度）', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };

      const dispatchSubscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      dispatchSubscriber.setPrimaryAgent('agent-1');
      dispatchSubscriber.registerSession('session-dispatch', {
        channel: 'qqbot',
        envelopeId: 'env-dispatch',
      });
      dispatchSubscriber.start();

      const dispatchEvent: RuntimeEvent = {
        type: 'agent_runtime_dispatch',
        sessionId: 'session-dispatch',
        timestamp: new Date().toISOString(),
        payload: {
          dispatchId: 'dispatch-test-1',
          sourceAgentId: 'agent-1',
          targetAgentId: 'agent-2',
          status: 'queued',
          queuePosition: 1,
        },
      };

      await eventBus.emit(dispatchEvent);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockMessageHub.routeToOutput).toHaveBeenCalledWith(
        'channel-bridge-qqbot',
        expect.objectContaining({
          statusUpdate: expect.objectContaining({
            task: expect.objectContaining({
              taskId: 'dispatch-test-1',
              sourceAgentId: 'agent-1',
              targetAgentId: 'agent-2',
            }),
            status: expect.objectContaining({
              state: 'running',
              summary: expect.stringContaining('派发 agent-2'),
            }),
          }),
        }),
      );

      const dispatchCall = mockMessageHub.routeToOutput.mock.calls.find(
        (call: unknown[]) => call[0] === 'channel-bridge-qqbot',
      );
      expect(dispatchCall).toBeDefined();
      const payload = dispatchCall?.[1] as { content?: string };
      const content = typeof payload?.content === 'string' ? payload.content : '';
      const summaryOccurrences = (content.match(/派发 agent-2/g) || []).length;
      expect(summaryOccurrences).toBe(1);

      dispatchSubscriber.stop();
    });

    it('dispatch 因 SIGTERM 中断时，通道状态应显示 interrupted 而不是 failed', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };

      const dispatchSubscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      dispatchSubscriber.setPrimaryAgent('agent-1');
      dispatchSubscriber.registerSession('session-dispatch-sigterm', {
        channel: 'qqbot',
        envelopeId: 'env-dispatch-sigterm',
      });
      dispatchSubscriber.start();

      const dispatchEvent: RuntimeEvent = {
        type: 'agent_runtime_dispatch',
        sessionId: 'session-dispatch-sigterm',
        timestamp: new Date().toISOString(),
        payload: {
          dispatchId: 'dispatch-sigterm-1',
          sourceAgentId: 'finger-system-agent',
          targetAgentId: 'finger-reviewer',
          status: 'failed',
          result: {
            status: 'failed',
            error: 'chat-codex process exited with signal SIGTERM',
            summary: 'chat-codex process exited with signal SIGTERM',
          },
        },
      };

      await eventBus.emit(dispatchEvent);
      await new Promise(resolve => setTimeout(resolve, 80));

      const dispatchCall = mockMessageHub.routeToOutput.mock.calls.find(
        (call: unknown[]) => call[0] === 'channel-bridge-qqbot',
      );
      expect(dispatchCall).toBeDefined();
      const payload = dispatchCall?.[1] as { statusUpdate?: { status?: { state?: string; summary?: string } } };
      const summary = payload?.statusUpdate?.status?.summary ?? '';
      expect(payload?.statusUpdate?.status?.state).toBe('waiting');
      expect(summary).toContain('状态: interrupted');
      expect(summary).toContain('运行时重启导致本次派发中断');

      dispatchSubscriber.stop();
    });

    it('启动恢复来源的 transient dispatch（queued/running/completed）应静默，不推送到通道', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };

      const dispatchSubscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      dispatchSubscriber.setPrimaryAgent('finger-system-agent');
      dispatchSubscriber.registerSession('session-dispatch-startup-noise', {
        channel: 'qqbot',
        envelopeId: 'env-dispatch-startup-noise',
      });
      dispatchSubscriber.start();

      const dispatchEvent: RuntimeEvent = {
        type: 'agent_runtime_dispatch',
        sessionId: 'session-dispatch-startup-noise',
        timestamp: new Date().toISOString(),
        payload: {
          dispatchId: 'dispatch-startup-noise-1',
          sourceAgentId: 'system-recovery',
          targetAgentId: 'finger-system-agent',
          status: 'completed',
          result: {
            status: 'completed',
            summary: 'Startup recovery no-op completed',
          },
        },
      };

      await eventBus.emit(dispatchEvent);
      await new Promise(resolve => setTimeout(resolve, 80));

      expect(mockMessageHub.routeToOutput).not.toHaveBeenCalled();
      dispatchSubscriber.stop();
    });

    it('启动恢复来源的非重启失败 dispatch 仍应推送（保留关键错误信号）', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };

      const dispatchSubscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      dispatchSubscriber.setPrimaryAgent('finger-system-agent');
      dispatchSubscriber.registerSession('session-dispatch-startup-hard-fail', {
        channel: 'qqbot',
        envelopeId: 'env-dispatch-startup-hard-fail',
      });
      dispatchSubscriber.start();

      const dispatchEvent: RuntimeEvent = {
        type: 'agent_runtime_dispatch',
        sessionId: 'session-dispatch-startup-hard-fail',
        timestamp: new Date().toISOString(),
        payload: {
          dispatchId: 'dispatch-startup-hard-fail-1',
          sourceAgentId: 'system-recovery',
          targetAgentId: 'finger-system-agent',
          status: 'failed',
          result: {
            status: 'failed',
            error: 'startup resume failed due to malformed state payload',
            summary: 'startup resume failed due to malformed state payload',
          },
        },
      };

      await eventBus.emit(dispatchEvent);
      await new Promise(resolve => setTimeout(resolve, 80));

      expect(mockMessageHub.routeToOutput).toHaveBeenCalled();
      const dispatchCall = mockMessageHub.routeToOutput.mock.calls.find(
        (call: unknown[]) => call[0] === 'channel-bridge-qqbot',
      );
      expect(dispatchCall).toBeDefined();
      const payload = dispatchCall?.[1] as { statusUpdate?: { status?: { state?: string; summary?: string } } };
      expect(payload?.statusUpdate?.status?.state).toBe('failed');
      expect(payload?.statusUpdate?.status?.summary ?? '').toContain('状态: failed');
      dispatchSubscriber.stop();
    });


    it('system-heartbeat 派发到 system agent 的 queued 更新应静默', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };
      const dispatchSubscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      dispatchSubscriber.setPrimaryAgent('finger-system-agent');
      dispatchSubscriber.registerSession('session-dispatch-heartbeat-system-noise', {
        channel: 'qqbot',
        envelopeId: 'env-dispatch-heartbeat-system-noise',
      });
      dispatchSubscriber.start();

      const dispatchEvent: RuntimeEvent = {
        type: 'agent_runtime_dispatch',
        sessionId: 'session-dispatch-heartbeat-system-noise',
        timestamp: new Date().toISOString(),
        payload: {
          dispatchId: 'dispatch-heartbeat-system-noise-1',
          sourceAgentId: 'system-heartbeat',
          targetAgentId: 'finger-system-agent',
          status: 'queued',
          queuePosition: 1,
          result: {
            status: 'queued',
            summary: '新任务已派发，等待执行',
          },
        },
      };

      await eventBus.emit(dispatchEvent);
      await new Promise(resolve => setTimeout(resolve, 80));

      expect(mockMessageHub.routeToOutput).not.toHaveBeenCalled();
      dispatchSubscriber.stop();
    });

    it('mailbox 协调事件回流到 system agent 时应静默（非失败）', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };
      const dispatchSubscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      dispatchSubscriber.setPrimaryAgent('finger-system-agent');
      dispatchSubscriber.registerSession('session-dispatch-mailbox-system-noise', {
        channel: 'qqbot',
        envelopeId: 'env-dispatch-mailbox-system-noise',
      });
      dispatchSubscriber.start();

      const dispatchEvent: RuntimeEvent = {
        type: 'agent_runtime_dispatch',
        sessionId: 'session-dispatch-mailbox-system-noise',
        timestamp: new Date().toISOString(),
        payload: {
          dispatchId: 'dispatch-mailbox-system-noise-1',
          sourceAgentId: 'finger-reviewer',
          targetAgentId: 'finger-system-agent',
          status: 'completed',
          result: {
            status: 'completed',
            summary: 'flow-healthcheck-001 PASS',
            mailboxMessageId: 'msg-abc123',
          },
        },
      };

      await eventBus.emit(dispatchEvent);
      await new Promise(resolve => setTimeout(resolve, 80));

      expect(mockMessageHub.routeToOutput).not.toHaveBeenCalled();
      dispatchSubscriber.stop();
    });

    it('mailbox 协调事件回流到 system agent 时，失败态仍应推送', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };
      const dispatchSubscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      dispatchSubscriber.setPrimaryAgent('finger-system-agent');
      dispatchSubscriber.registerSession('session-dispatch-mailbox-system-failed', {
        channel: 'qqbot',
        envelopeId: 'env-dispatch-mailbox-system-failed',
      });
      dispatchSubscriber.start();

      const dispatchEvent: RuntimeEvent = {
        type: 'agent_runtime_dispatch',
        sessionId: 'session-dispatch-mailbox-system-failed',
        timestamp: new Date().toISOString(),
        payload: {
          dispatchId: 'dispatch-mailbox-system-failed-1',
          sourceAgentId: 'finger-reviewer',
          targetAgentId: 'finger-system-agent',
          status: 'failed',
          result: {
            status: 'failed',
            summary: 'mailbox coordination failed',
            error: 'mailbox coordination failed',
            mailboxMessageId: 'msg-abc456',
          },
        },
      };

      await eventBus.emit(dispatchEvent);
      await new Promise(resolve => setTimeout(resolve, 80));

      expect(mockMessageHub.routeToOutput).toHaveBeenCalled();
      dispatchSubscriber.stop();
    });

    it('heartbeat 无动作（No actionable work）不应推送派发更新', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };
      const dispatchSubscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      dispatchSubscriber.setPrimaryAgent('agent-1');
      dispatchSubscriber.registerSession('session-dispatch-heartbeat-noop', {
        channel: 'qqbot',
        envelopeId: 'env-dispatch-heartbeat-noop',
      });
      dispatchSubscriber.start();

      mockSessionManager.getSession.mockReturnValue({
        projectPath: '/tmp/project-a',
        context: {
          projectTaskState: {
            active: true,
            status: 'in_progress',
            sourceAgentId: 'finger-system-agent',
            targetAgentId: 'finger-project-agent',
            updatedAt: new Date().toISOString(),
            taskId: 'task-heartbeat-noop',
          },
        },
      });
      const dispatchEvent: RuntimeEvent = {
        type: 'agent_runtime_dispatch',
        sessionId: 'session-dispatch-heartbeat-noop',
        timestamp: new Date().toISOString(),
        payload: {
          dispatchId: 'dispatch-heartbeat-noop-1',
          sourceAgentId: 'system-heartbeat',
          targetAgentId: 'finger-project-agent',
          status: 'completed',
          result: {
            status: 'completed',
            summary: 'No actionable work. stale watchdog phantom entries already complete.',
          },
        },
      };

      await eventBus.emit(dispatchEvent);
      await new Promise(resolve => setTimeout(resolve, 80));

      expect(mockMessageHub.routeToOutput).not.toHaveBeenCalled();
      expect(mockSessionManager.updateContext).toHaveBeenCalledWith(
        'session-dispatch-heartbeat-noop',
        expect.objectContaining({
          projectTaskState: null,
        }),
      );
      dispatchSubscriber.stop();
    });

    it('heartbeat 有效派发更新应包含心跳时间标签', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };
      const dispatchSubscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      dispatchSubscriber.setPrimaryAgent('agent-1');
      dispatchSubscriber.registerSession('session-dispatch-heartbeat-active', {
        channel: 'qqbot',
        envelopeId: 'env-dispatch-heartbeat-active',
      });
      dispatchSubscriber.start();

      const dispatchEvent: RuntimeEvent = {
        type: 'agent_runtime_dispatch',
        sessionId: 'session-dispatch-heartbeat-active',
        timestamp: '2026-03-30T13:08:00.000Z',
        payload: {
          dispatchId: 'dispatch-heartbeat-active-1',
          sourceAgentId: 'system-heartbeat',
          targetAgentId: 'finger-project-agent',
          status: 'queued',
          queuePosition: 1,
          result: {
            status: 'queued',
            summary: '发现待处理任务，进入队列',
          },
        },
      };

      await eventBus.emit(dispatchEvent);
      await new Promise(resolve => setTimeout(resolve, 80));

      expect(mockMessageHub.routeToOutput).toHaveBeenCalled();
      const dispatchCall = mockMessageHub.routeToOutput.mock.calls.find(
        (call: unknown[]) => call[0] === 'channel-bridge-qqbot',
      );
      expect(dispatchCall).toBeDefined();
      const payload = dispatchCall?.[1] as { statusUpdate?: { status?: { summary?: string } } };
      const summary = payload?.statusUpdate?.status?.summary ?? '';
      expect(summary).toContain('心跳时间:');

      dispatchSubscriber.stop();
    });

    it('mailbox 派发状态应显示语义摘要而不是原始 mailbox id', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };

      const dispatchSubscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      dispatchSubscriber.setPrimaryAgent('agent-1');
      dispatchSubscriber.registerSession('session-dispatch-mailbox', {
        channel: 'qqbot',
        envelopeId: 'env-dispatch-mailbox',
      });
      dispatchSubscriber.start();

      const mailboxAppend = heartbeatMailbox.append('agent-2', {
        type: 'dispatch-task',
        envelope: {
          title: 'Queued Dispatch Task',
          shortDescription: '队列超时后转入邮箱，等待 agent-2 空闲后处理。',
        },
      }, {
        category: 'dispatch-task',
      });

      const dispatchEvent: RuntimeEvent = {
        type: 'agent_runtime_dispatch',
        sessionId: 'session-dispatch-mailbox',
        timestamp: new Date().toISOString(),
        payload: {
          dispatchId: 'dispatch-mailbox-1',
          sourceAgentId: 'agent-1',
          targetAgentId: 'agent-2',
          status: 'queued',
          result: {
            status: 'queued_mailbox',
            messageId: mailboxAppend.id,
            summary: `Target busy timeout; task moved to mailbox (${mailboxAppend.id}) for agent-2`,
          },
        },
      };

      await eventBus.emit(dispatchEvent);
      await new Promise(resolve => setTimeout(resolve, 80));

      const dispatchCall = mockMessageHub.routeToOutput.mock.calls.find(
        (call: unknown[]) => call[0] === 'channel-bridge-qqbot',
      );
      expect(dispatchCall).toBeDefined();
      const payload = dispatchCall?.[1] as { content?: string; statusUpdate?: { status?: { summary?: string } } };
      const content = typeof payload?.content === 'string' ? payload.content : '';
      const summary = payload?.statusUpdate?.status?.summary ?? '';
      expect(content).toContain('mailbox: Queued Dispatch Task');
      expect(summary).toContain('mailbox: Queued Dispatch Task');
      expect(content).not.toContain(mailboxAppend.id);
      expect(summary).not.toContain(mailboxAppend.id);

      heartbeatMailbox.remove('agent-2', mailboxAppend.id);
      dispatchSubscriber.stop();
    });

    it('普通 dispatch result.messageId 不应被错误标记为 mailbox', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };

      const dispatchSubscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      dispatchSubscriber.setPrimaryAgent('agent-1');
      dispatchSubscriber.registerSession('session-dispatch-normal', {
        channel: 'qqbot',
        envelopeId: 'env-dispatch-normal',
      });
      dispatchSubscriber.start();

      const externalMessageId = 'ROBOT1.0_RfEjr0m4Gkchob94UGP.rBgrInWXSDk2G3yXlkKGQs7EL3SmZjNW7ZjW4ULCIXyI';
      const dispatchEvent: RuntimeEvent = {
        type: 'agent_runtime_dispatch',
        sessionId: 'session-dispatch-normal',
        timestamp: new Date().toISOString(),
        payload: {
          dispatchId: 'dispatch-normal-1',
          sourceAgentId: 'agent-1',
          targetAgentId: 'agent-2',
          status: 'completed',
          result: {
            status: 'completed',
            messageId: externalMessageId,
            summary: '任务已完成并返回结果',
          },
        },
      };

      await eventBus.emit(dispatchEvent);
      await new Promise(resolve => setTimeout(resolve, 80));

      const dispatchCall = mockMessageHub.routeToOutput.mock.calls.find(
        (call: unknown[]) => call[0] === 'channel-bridge-qqbot',
      );
      expect(dispatchCall).toBeDefined();
      const payload = dispatchCall?.[1] as { content?: string; statusUpdate?: { status?: { summary?: string } } };
      const content = typeof payload?.content === 'string' ? payload.content : '';
      const summary = payload?.statusUpdate?.status?.summary ?? '';
      expect(content).toContain('摘要: 任务已完成并返回结果');
      expect(summary).toContain('摘要: 任务已完成并返回结果');
      expect(content).not.toContain('mailbox:');
      expect(summary).not.toContain('mailbox:');
      expect(content).not.toContain(externalMessageId);
      expect(summary).not.toContain(externalMessageId);

      dispatchSubscriber.stop();
    });

    it('当 childSessionId 与父会话相同/等于当前会话时，不应显示子会话关系', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };

      const dispatchSubscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      dispatchSubscriber.setPrimaryAgent('agent-1');
      dispatchSubscriber.registerSession('session-dispatch-relation', {
        channel: 'qqbot',
        envelopeId: 'env-dispatch-relation',
      });
      dispatchSubscriber.start();

      const dispatchEvent: RuntimeEvent = {
        type: 'agent_runtime_dispatch',
        sessionId: 'session-dispatch-relation',
        timestamp: new Date().toISOString(),
        payload: {
          dispatchId: 'dispatch-relation-1',
          sourceAgentId: 'agent-1',
          targetAgentId: 'finger-system-agent',
          status: 'completed',
          childSessionId: 'session-dispatch-relation',
          parentSessionId: 'session-dispatch-relation',
          result: {
            status: 'completed',
            summary: 'ok',
          },
        },
      };

      await eventBus.emit(dispatchEvent);
      await new Promise(resolve => setTimeout(resolve, 80));

      const dispatchCall = mockMessageHub.routeToOutput.mock.calls.find(
        (call: unknown[]) => call[0] === 'channel-bridge-qqbot',
      );
      expect(dispatchCall).toBeDefined();
      const payload = dispatchCall?.[1] as { content?: string };
      const content = typeof payload?.content === 'string' ? payload.content : '';
      expect(content).not.toContain('关系: 子会话');
      expect(content).not.toContain('父会话');

      dispatchSubscriber.stop();
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
          target: 'unknown',
          content: expect.any(String),
          originalEnvelope: expect.objectContaining({
            channelId: 'qqbot',
            metadata: expect.objectContaining({
              messageId: 'env-root',
            }),
          }),
        })
      );
      const relationCall = mockMessageHub.routeToOutput.mock.calls.find(
        (call: unknown[]) => call[0] === 'channel-bridge-qqbot',
      );
      const relationPayload = relationCall?.[1] as { content?: string };
      expect(relationPayload?.content ?? '').toContain('关系: 子会话');

      fallbackSubscriber.stop();
    });

    it('应该抑制 qqbot/openclaw-weixin 的原始 tool_error 透传', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };

      const toolErrorSubscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      toolErrorSubscriber.setPrimaryAgent('agent-1');
      toolErrorSubscriber.registerSession('session-tool-error', {
        channel: 'qqbot',
        envelopeId: 'env-tool-error',
      });
      toolErrorSubscriber.start();

      const event: RuntimeEvent = {
        type: 'tool_error',
        sessionId: 'session-tool-error',
        timestamp: new Date().toISOString(),
        agentId: 'agent-1',
        toolId: 'tool-error-1',
        toolName: 'write_stdin',
        payload: {
          error: 'Error: failed to write to stdin for session 58',
          duration: 1,
        },
      } as RuntimeEvent;

      await eventBus.emit(event);
      await new Promise(resolve => setTimeout(resolve, 80));

      expect(mockMessageHub.routeToOutput).not.toHaveBeenCalled();
      toolErrorSubscriber.stop();
    });

    it('应该继续向非外部聊天渠道发送 tool_error 状态', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };

      const toolErrorSubscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      toolErrorSubscriber.setPrimaryAgent('agent-1');
      toolErrorSubscriber.registerSession('session-tool-error-web', {
        channel: 'webui',
        envelopeId: 'env-tool-error-web',
      });
      toolErrorSubscriber.start();

      const event: RuntimeEvent = {
        type: 'tool_error',
        sessionId: 'session-tool-error-web',
        timestamp: new Date().toISOString(),
        agentId: 'agent-1',
        toolId: 'tool-error-web-1',
        toolName: 'write_stdin',
        payload: {
          error: 'Error: failed to write to stdin for session 58',
          duration: 1,
        },
      } as RuntimeEvent;

      await eventBus.emit(event);
      await new Promise(resolve => setTimeout(resolve, 80));

      expect(mockMessageHub.routeToOutput).toHaveBeenCalledWith(
        'channel-bridge-webui',
        expect.objectContaining({
          statusUpdate: expect.objectContaining({
            status: expect.objectContaining({
              state: 'failed',
              summary: expect.stringContaining('failed'),
            }),
          }),
        }),
      );
      toolErrorSubscriber.stop();
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
          target: 'group:group-456',
          content: expect.any(String),
          originalEnvelope: expect.objectContaining({
            channelId: 'qqbot',
            senderId: 'user-123',
            metadata: expect.objectContaining({
              messageId: 'env-mock',
              groupId: 'group-456',
            }),
          }),
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
      subscriber.start();
      // 验证启动后 _stopCleanup 已设置
      expect((subscriber as any)._stopCleanup).not.toBeNull();

      subscriber.stop();
      // 验证停止后 _stopCleanup 已清理
      expect((subscriber as any)._stopCleanup).toBeNull();
    });
  });

  describe('定时器清理', () => {
    it('应该在停止时清理定时器', () => {
      subscriber.start();
      expect((subscriber as any)._stopCleanup).not.toBeNull();

      subscriber.stop();
      expect((subscriber as any)._stopCleanup).toBeNull();
    });
  });

  describe('Step 批量推送', () => {
    it('应该在收到 thought 时立刻推送 reasoning（不走 stepBatch）', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };
      const mockChannelBridgeManager = {
        getPushSettings: vi.fn().mockReturnValue({
          reasoning: true,
          bodyUpdates: false,
          statusUpdate: true,
          toolCalls: false,
          stepUpdates: true,
          stepBatch: 5,
          progressUpdates: true,
        }),
      };

      const stepSubscriber = new AgentStatusSubscriber(
        eventBus, mockAgentRuntimeDeps, mockMessageHub, mockChannelBridgeManager
      );
      stepSubscriber.setPrimaryAgent('agent-1');
      stepSubscriber.registerSession('step-session-reasoning', {
        channel: 'qqbot',
        envelopeId: 'env-step-reasoning',
        userId: 'user-1',
      });
      stepSubscriber.start();

      for (let i = 1; i <= 2; i++) {
        const stepEvent: RuntimeEvent = {
          type: 'agent_step_completed',
          sessionId: 'step-session-reasoning',
          timestamp: new Date().toISOString(),
          agentId: 'agent-1',
          payload: {
            round: i,
            thought: `思考 ${i}`,
            success: true,
          },
        } as any;
        await eventBus.emit(stepEvent);
      }
      await new Promise(resolve => setTimeout(resolve, 80));

      expect(mockMessageHub.routeToOutput).toHaveBeenCalledTimes(2);
      expect(mockMessageHub.routeToOutput).toHaveBeenNthCalledWith(
        1,
        'channel-bridge-qqbot',
        expect.objectContaining({
          content: expect.stringContaining('思考：思考 1'),
        }),
      );
      expect(mockMessageHub.routeToOutput).toHaveBeenNthCalledWith(
        2,
        'channel-bridge-qqbot',
        expect.objectContaining({
          content: expect.stringContaining('思考：思考 2'),
        }),
      );

      stepSubscriber.stop();
    });

    it('应该在 stepBatch 达到阈值时才推送', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };
      const mockChannelBridgeManager = {
        getPushSettings: vi.fn().mockReturnValue({
          reasoning: false,
          statusUpdate: true,
          toolCalls: false,
          stepUpdates: true,
          stepBatch: 3, // 每 3 个 step 推送一次
        }),
      };

      const stepSubscriber = new AgentStatusSubscriber(
        eventBus, mockAgentRuntimeDeps, mockMessageHub, mockChannelBridgeManager
      );
      stepSubscriber.setPrimaryAgent('agent-1');
      stepSubscriber.registerSession('step-session-1', {
        channel: 'qqbot',
        envelopeId: 'env-step-1',
      });
      stepSubscriber.start();

      // 发送 2 个 step 事件（未达到阈值 3，不应推送）
      for (let i = 1; i <= 2; i++) {
        const stepEvent: RuntimeEvent = {
          type: 'agent_step_completed',
          sessionId: 'step-session-1',
          timestamp: new Date().toISOString(),
          agentId: 'agent-1',
          payload: {
            round: i,
            action: `操作 ${i}`,
            success: true,
          },
        } as any;
        await eventBus.emit(stepEvent);
      }
      await new Promise(resolve => setTimeout(resolve, 100));

      // 2 个 step 不应触发推送（阈值 3）
      expect(mockMessageHub.routeToOutput).not.toHaveBeenCalled();

      // 发送第 3 个 step（达到阈值，应推送）
      const stepEvent3: RuntimeEvent = {
        type: 'agent_step_completed',
        sessionId: 'step-session-1',
        timestamp: new Date().toISOString(),
        agentId: 'agent-1',
        payload: {
          round: 3,
          action: '操作 3',
          success: true,
        },
      } as any;
      await eventBus.emit(stepEvent3);
      await new Promise(resolve => setTimeout(resolve, 100));

      // 应该推送了 1 次批量消息
      expect(mockMessageHub.routeToOutput).toHaveBeenCalledTimes(1);
      const callArgs = mockMessageHub.routeToOutput.mock.calls[0];
      expect(callArgs[0]).toBe('channel-bridge-qqbot');
      expect(callArgs[1].statusUpdate.status.summary).toContain('3');
      expect(callArgs[1].statusUpdate.display.title).toBe('📋 中间步骤');

      stepSubscriber.stop();
    });

    it('应该在 channel stepUpdates=false 时仍遵循 update-stream 默认策略推送 step', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };
      const mockChannelBridgeManager = {
        getPushSettings: vi.fn().mockReturnValue({
          reasoning: false,
          statusUpdate: true,
          toolCalls: false,
          stepUpdates: false, // 禁用 step 更新
          stepBatch: 5,
        }),
      };

      const stepSubscriber = new AgentStatusSubscriber(
        eventBus, mockAgentRuntimeDeps, mockMessageHub, mockChannelBridgeManager
      );
      stepSubscriber.setPrimaryAgent('agent-1');
      stepSubscriber.registerSession('step-session-2', {
        channel: 'qqbot',
        envelopeId: 'env-step-2',
      });
      stepSubscriber.start();

      // 发送 10 个 step 事件。
      // 合并优先级：session > update-stream > channel pushSettings。
      // 因此即使 channel stepUpdates=false，默认 update-stream 仍会推送 step 批次。
      for (let i = 1; i <= 10; i++) {
        const stepEvent: RuntimeEvent = {
          type: 'agent_step_completed',
          sessionId: 'step-session-2',
          timestamp: new Date().toISOString(),
          agentId: 'agent-1',
          payload: { round: i, action: `操作 ${i}`, success: true },
        } as any;
        await eventBus.emit(stepEvent);
      }
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockMessageHub.routeToOutput).toHaveBeenCalledTimes(2);
      const firstCall = mockMessageHub.routeToOutput.mock.calls[0];
      const secondCall = mockMessageHub.routeToOutput.mock.calls[1];
      expect(firstCall[0]).toBe('channel-bridge-qqbot');
      expect(secondCall[0]).toBe('channel-bridge-qqbot');
      expect(firstCall[1]?.statusUpdate?.status?.summary).toContain('5');
      expect(secondCall[1]?.statusUpdate?.status?.summary).toContain('5');
      stepSubscriber.stop();
    });

    it('应该在终态时 flush 剩余 steps', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };
      const mockChannelBridgeManager = {
        getPushSettings: vi.fn().mockReturnValue({
          reasoning: false,
          statusUpdate: true,
          toolCalls: false,
          stepUpdates: true,
          stepBatch: 5,
        }),
      };

      const stepSubscriber = new AgentStatusSubscriber(
        eventBus, mockAgentRuntimeDeps, mockMessageHub, mockChannelBridgeManager
      );
      stepSubscriber.setPrimaryAgent('agent-1');
      stepSubscriber.registerSession('step-session-3', {
        channel: 'qqbot',
        envelopeId: 'env-step-3',
      });
      stepSubscriber.start();

      // 发送 3 个 step（未达到阈值 5）
      for (let i = 1; i <= 3; i++) {
        const stepEvent: RuntimeEvent = {
          type: 'agent_step_completed',
          sessionId: 'step-session-3',
          timestamp: new Date().toISOString(),
          agentId: 'agent-1',
          payload: { round: i, action: `操作 ${i}`, success: true },
        } as any;
        await eventBus.emit(stepEvent);
      }
      await new Promise(resolve => setTimeout(resolve, 100));

      // 3 个 step 未达到阈值，不应推送
      expect(mockMessageHub.routeToOutput).not.toHaveBeenCalled();

      // 发送 completed 状态事件（终态应触发 flush）
      const completedEvent: RuntimeEvent = {
        type: 'agent_runtime_status',
        sessionId: 'step-session-3',
        timestamp: new Date().toISOString(),
        payload: {
          scope: 'global',
          status: 'completed',
          agentId: 'agent-1',
          summary: 'Task completed',
        },
      };
      await eventBus.emit(completedEvent);
      await new Promise(resolve => setTimeout(resolve, 100));

      // flush 推送了剩余的 3 个 steps + completed 状态更新
      expect(mockMessageHub.routeToOutput).toHaveBeenCalled();
      // 至少调用 2 次：flush steps + completed status
      expect(mockMessageHub.routeToOutput.mock.calls.length).toBeGreaterThanOrEqual(2);

      stepSubscriber.stop();
    });

    it('应该把 waiting_for_user 问题推送到渠道', async () => {
      const mockMessageHub = {
        routeToOutput: vi.fn().mockResolvedValue(undefined),
      };

      const waitingSubscriber = new AgentStatusSubscriber(eventBus, mockAgentRuntimeDeps, mockMessageHub);
      waitingSubscriber.registerSession('session-ask', {
        channel: 'qqbot',
        envelopeId: 'env-ask',
        userId: 'user-ask',
      });
      waitingSubscriber.start();

      const event: RuntimeEvent = {
        type: 'waiting_for_user',
        sessionId: 'session-ask',
        workflowId: 'wf-ask',
        timestamp: new Date().toISOString(),
        payload: {
          reason: 'confirmation_required',
          options: [
            { id: 'confirm', label: '确认', description: '确认执行' },
            { id: 'cancel', label: '取消', description: '取消执行' },
          ],
          context: {
            requestId: 'ask-1',
            question: '是否继续执行？',
            agentId: 'finger-project-agent',
          },
        },
      } as RuntimeEvent;

      await eventBus.emit(event);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockMessageHub.routeToOutput).toHaveBeenCalledWith(
        'channel-bridge-qqbot',
        expect.objectContaining({
          channelId: 'qqbot',
          target: 'user-ask',
          content: expect.stringContaining('是否继续执行？'),
          statusUpdate: expect.objectContaining({
            status: expect.objectContaining({ state: 'waiting' }),
          }),
        }),
      );

      waitingSubscriber.stop();
    });
  });
});
