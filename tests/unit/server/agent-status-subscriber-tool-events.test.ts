import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEvent } from '../../../src/runtime/events.js';
import { UnifiedEventBus } from '../../../src/runtime/event-bus.js';
import { AgentStatusSubscriber } from '../../../src/server/modules/agent-status-subscriber.js';

describe('AgentStatusSubscriber tool event formatting', () => {
  let eventBus: UnifiedEventBus;
  let subscriber: AgentStatusSubscriber;

  const mockSessionManager = {
    getSession: vi.fn(),
  };

  const mockDeps = {
    sessionManager: mockSessionManager,
    agentRuntimeBlock: {
      execute: vi.fn().mockResolvedValue({
        agents: [
          { id: 'finger-system-agent', name: 'SystemBot', type: 'system' },
        ],
      }),
    },
  } as any;

  const mockMessageHub = {
    routeToOutput: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    eventBus = new UnifiedEventBus();
    subscriber = new AgentStatusSubscriber(eventBus, mockDeps, mockMessageHub as any);
    subscriber.setPrimaryAgent('finger-system-agent');
    subscriber.registerSession('session-tool', {
      channel: 'qqbot',
      envelopeId: 'env-tool',
    });
    subscriber.start();
  });

  afterEach(() => {
    subscriber.stop();
    mockMessageHub.routeToOutput.mockReset();
  });

  it('does not push tool_call events to channel output', async () => {
    const event: RuntimeEvent = {
      type: 'tool_call',
      sessionId: 'session-tool',
      timestamp: new Date().toISOString(),
      agentId: 'finger-system-agent',
      toolId: 'tool-1',
      toolName: 'exec_command',
      payload: {
        input: { cmd: 'cat HEARTBEAT.md' },
      },
    } as RuntimeEvent;

    await eventBus.emit(event);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(mockMessageHub.routeToOutput).not.toHaveBeenCalled();
  });

  it('pushes parsed tool_result summary with verb/target/status', async () => {
    const event: RuntimeEvent = {
      type: 'tool_result',
      sessionId: 'session-tool',
      timestamp: new Date().toISOString(),
      agentId: 'finger-system-agent',
      toolId: 'tool-2',
      toolName: 'exec_command',
      payload: {
        input: { cmd: 'cat HEARTBEAT.md' },
        output: { ok: true, output: '# HEARTBEAT' },
        duration: 12,
      },
    } as RuntimeEvent;

    await eventBus.emit(event);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(mockMessageHub.routeToOutput).toHaveBeenCalledTimes(1);
    const call = mockMessageHub.routeToOutput.mock.calls[0];
    const payload = call[1] as { statusUpdate?: { task?: { taskDescription?: string }; status?: { summary?: string } } };
    const description = payload.statusUpdate?.task?.taskDescription ?? '';
    const summary = payload.statusUpdate?.status?.summary ?? '';
    expect(description).toContain('[read]');
    expect(description).toContain('HEARTBEAT.md');
    expect(description).toContain('success');
    expect(summary).toBe(description);
  });

  it('pushes mailbox.status summary with unread counters from real payload', async () => {
    const event: RuntimeEvent = {
      type: 'tool_result',
      sessionId: 'session-tool',
      timestamp: new Date().toISOString(),
      agentId: 'finger-system-agent',
      toolId: 'tool-mailbox-status',
      toolName: 'mailbox.status',
      payload: {
        input: {},
        output: {
          success: true,
          counts: {
            total: 2,
            unread: 1,
            pending: 1,
          },
          recentUnread: [
            {
              id: 'msg-1774330605368-q3vkv5',
              category: 'heartbeat-task',
            },
          ],
        },
      },
    } as RuntimeEvent;

    await eventBus.emit(event);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(mockMessageHub.routeToOutput).toHaveBeenCalledTimes(1);
    const call = mockMessageHub.routeToOutput.mock.calls[0];
    const payload = call[1] as { statusUpdate?: { task?: { taskDescription?: string } } };
    const description = payload.statusUpdate?.task?.taskDescription ?? '';
    expect(description).toContain('[read]');
    expect(description).toContain('status');
    expect(description).toContain('total=2');
    expect(description).toContain('unread=1');
    expect(description).toContain('pending=1');
    expect(description).toContain('next=msg-1774330605368-q3vkv5');
  });
});
