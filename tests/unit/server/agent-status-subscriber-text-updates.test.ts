import { describe, it, expect, vi } from 'vitest';
import { UnifiedEventBus } from '../../../src/runtime/event-bus.js';
import { AgentStatusSubscriber } from '../../../src/server/modules/agent-status-subscriber.js';
import type { AgentRuntimeDeps } from '../../../src/server/modules/agent-runtime/types.js';
import { heartbeatMailbox } from '../../../src/server/modules/heartbeat-mailbox.js';
import type { RuntimeEvent } from '../../../src/runtime/events.js';

function createMinimalDeps(): AgentRuntimeDeps {
  return {
    sessionManager: {
      getSession: vi.fn(() => null),
    } as unknown as AgentRuntimeDeps['sessionManager'],
    agentRuntimeBlock: {
      execute: vi.fn(async () => ({ agents: [] })),
    } as unknown as AgentRuntimeDeps['agentRuntimeBlock'],
  } as AgentRuntimeDeps;
}

describe('AgentStatusSubscriber text updates', () => {
  it('forces reasoning/body push for qqbot even when pushSettings are disabled', async () => {
    const eventBus = new UnifiedEventBus();
    const messageHub = {
      routeToOutput: vi.fn().mockResolvedValue(undefined),
    };
    const channelBridgeManager = {
      getPushSettings: vi.fn().mockReturnValue({
        reasoning: false,
        bodyUpdates: false,
        statusUpdate: true,
        toolCalls: false,
        stepUpdates: true,
        stepBatch: 5,
        progressUpdates: true,
      }),
    };

    const subscriber = new AgentStatusSubscriber(
      eventBus,
      createMinimalDeps(),
      messageHub as any,
      channelBridgeManager as any,
    );
    subscriber.registerSession('session-qq', {
      channel: 'qqbot',
      envelopeId: 'env-qq',
      userId: 'user-qq',
    });

    await subscriber.sendReasoningUpdate('session-qq', 'finger-system-agent', '先检查日志');
    await subscriber.sendBodyUpdate('session-qq', 'finger-system-agent', '正文增量');

    expect(messageHub.routeToOutput).toHaveBeenCalledTimes(2);
    expect(messageHub.routeToOutput).toHaveBeenNthCalledWith(
      1,
      'channel-bridge-qqbot',
      expect.objectContaining({
        content: '[system:finger-system-agent] 思考：先检查日志',
      }),
    );
    expect(messageHub.routeToOutput).toHaveBeenNthCalledWith(
      2,
      'channel-bridge-qqbot',
      expect.objectContaining({
        content: '[system:finger-system-agent] 正文：正文增量',
      }),
    );
  });

  it('respects pushSettings for non-verbose channels', async () => {
    const eventBus = new UnifiedEventBus();
    const messageHub = {
      routeToOutput: vi.fn().mockResolvedValue(undefined),
    };
    const channelBridgeManager = {
      getPushSettings: vi.fn().mockReturnValue({
        reasoning: false,
        bodyUpdates: false,
        statusUpdate: true,
        toolCalls: false,
        stepUpdates: true,
        stepBatch: 5,
        progressUpdates: true,
      }),
    };

    const subscriber = new AgentStatusSubscriber(
      eventBus,
      createMinimalDeps(),
      messageHub as any,
      channelBridgeManager as any,
    );
    subscriber.registerSession('session-webui', {
      channel: 'webui',
      envelopeId: 'env-webui',
      userId: 'user-webui',
    });

    await subscriber.sendReasoningUpdate('session-webui', 'finger-system-agent', '不会推送');
    await subscriber.sendBodyUpdate('session-webui', 'finger-system-agent', '不会推送');

    expect(messageHub.routeToOutput).not.toHaveBeenCalled();
  });

  it('includes mailbox.status snapshot in progress update', async () => {
    const eventBus = new UnifiedEventBus();
    const messageHub = {
      routeToOutput: vi.fn().mockResolvedValue(undefined),
    };
    const channelBridgeManager = {
      getPushSettings: vi.fn().mockReturnValue({
        reasoning: true,
        bodyUpdates: true,
        statusUpdate: true,
        toolCalls: false,
        stepUpdates: true,
        stepBatch: 5,
        progressUpdates: true,
      }),
    };

    const targetAgent = `agent-progress-${Date.now()}`;
    heartbeatMailbox.append(targetAgent, { text: 'first mailbox task' }, { category: 'task', priority: 1 });
    heartbeatMailbox.append(targetAgent, { text: 'second mailbox task' }, { category: 'task', priority: 2 });

    const subscriber = new AgentStatusSubscriber(
      eventBus,
      createMinimalDeps(),
      messageHub as any,
      channelBridgeManager as any,
    );
    subscriber.registerSession('session-progress', {
      channel: 'qqbot',
      envelopeId: 'env-progress',
      userId: 'user-progress',
    });

    await subscriber.sendProgressUpdate({
      sessionId: 'session-progress',
      agentId: targetAgent,
      summary: '正在处理任务',
      progress: {
        status: 'running',
        toolCallsCount: 2,
        modelRoundsCount: 1,
        elapsedMs: 1234,
      },
    });

    expect(messageHub.routeToOutput).toHaveBeenCalledTimes(1);
    const [, payload] = messageHub.routeToOutput.mock.calls[0];
    expect(payload.content).toContain('📬 mailbox.status(');
    expect(payload.content).toContain(`mailbox.status(${targetAgent}): unread=2 pending=2 processing=0`);
    expect(payload.statusUpdate.status.details.mailboxStatus.counts.unread).toBe(2);

    heartbeatMailbox.removeAll(targetAgent);
  });

  it('keeps session mapping after terminal status so reasoning/body updates still push', async () => {
    const eventBus = new UnifiedEventBus();
    const messageHub = {
      routeToOutput: vi.fn().mockResolvedValue(undefined),
    };
    const channelBridgeManager = {
      getPushSettings: vi.fn().mockReturnValue({
        reasoning: false,
        bodyUpdates: false,
        statusUpdate: false,
        toolCalls: false,
        stepUpdates: true,
        stepBatch: 5,
        progressUpdates: true,
      }),
    };

    const subscriber = new AgentStatusSubscriber(
      eventBus,
      createMinimalDeps(),
      messageHub as any,
      channelBridgeManager as any,
    );
    subscriber.registerSession('session-terminal', {
      channel: 'qqbot',
      envelopeId: 'env-terminal',
      userId: 'user-terminal',
    });
    subscriber.start();

    const completedEvent: RuntimeEvent = {
      type: 'agent_runtime_status',
      sessionId: 'session-terminal',
      timestamp: new Date().toISOString(),
      payload: {
        scope: 'session',
        status: 'completed',
        agentId: 'finger-project-agent',
        summary: 'dispatch done',
      },
    };
    await eventBus.emit(completedEvent);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // completed 之后仍应能继续推 reasoning/body 增量
    await subscriber.sendReasoningUpdate('session-terminal', 'finger-project-agent', '继续输出思考');
    await subscriber.sendBodyUpdate('session-terminal', 'finger-project-agent', '继续输出正文');

    expect(messageHub.routeToOutput).toHaveBeenCalledTimes(2);
    expect(messageHub.routeToOutput).toHaveBeenNthCalledWith(
      1,
      'channel-bridge-qqbot',
      expect.objectContaining({
        content: '[project:finger-project-agent] 思考：继续输出思考',
      }),
    );
    expect(messageHub.routeToOutput).toHaveBeenNthCalledWith(
      2,
      'channel-bridge-qqbot',
      expect.objectContaining({
        content: '[project:finger-project-agent] 正文：继续输出正文',
      }),
    );

    subscriber.stop();
  });
});
