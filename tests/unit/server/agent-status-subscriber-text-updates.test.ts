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
  it('respects pushSettings for qqbot (no longer hard-coded verbose)', async () => {
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

    // qqbot is no longer hard-coded verbose; it respects pushSettings
    await subscriber.sendReasoningUpdate('session-qq', 'finger-system-agent', '先检查日志');
    await subscriber.sendBodyUpdate('session-qq', 'finger-system-agent', '正文增量');

    // reasoning=false and bodyUpdates=false => nothing pushed
    expect(messageHub.routeToOutput).not.toHaveBeenCalled();
  });

  it('respects pushSettings for webui channels', async () => {
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

  it('deduplicates identical body updates within same session', async () => {
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

    const subscriber = new AgentStatusSubscriber(
      eventBus,
      createMinimalDeps(),
      messageHub as any,
      channelBridgeManager as any,
    );
    subscriber.registerSession('session-dedup', {
      channel: 'qqbot',
      envelopeId: 'env-dedup',
      userId: 'user-dedup',
    });

    // First body update should be sent
    await subscriber.sendBodyUpdate('session-dedup', 'finger-system-agent', '已完成所有删除操作。');
    // Second identical body update should be deduped
    await subscriber.sendBodyUpdate('session-dedup', 'finger-system-agent', '已完成所有删除操作。');
    // Third with different content should be sent
    await subscriber.sendBodyUpdate('session-dedup', 'finger-system-agent', '新增了补充说明。');
    // Fourth repeat of the third should be deduped
    await subscriber.sendBodyUpdate('session-dedup', 'finger-system-agent', '新增了补充说明。');

    // Only 2 unique body updates should have been sent
    const bodyCalls = messageHub.routeToOutput.mock.calls.filter(
      (call: any[]) => call[0] === 'channel-bridge-qqbot' && call[1]?.content?.startsWith('正文：'),
    );
    expect(bodyCalls).toHaveLength(2);
    expect(bodyCalls[0][1].content).toBe('正文：已完成所有删除操作。');
    expect(bodyCalls[1][1].content).toBe('正文：新增了补充说明。');
  });

  it('bodyUpdates + mirror: qqbot push mirrors to openclaw-weixin only once', async () => {
    const eventBus = new UnifiedEventBus();
    const routeCalls: Array<{ outputId: string; content: string }> = [];
    const messageHub = {
      routeToOutput: vi.fn().mockImplementation((outputId: string, msg: any) => {
        routeCalls.push({ outputId, content: msg.content });
        return Promise.resolve();
      }),
    };

    // qqbot sync targets include openclaw-weixin (mirrored by ChannelBridgeManager)
    // but AgentStatusSubscriber only sends to the source channel.
    // The mirror is handled by ChannelBridgeManager.sendMirrors() after primary send.
    const channelBridgeManager = {
      getPushSettings: vi.fn((channelId: string) => ({
        reasoning: true,
        bodyUpdates: true,
        statusUpdate: true,
        toolCalls: false,
        stepUpdates: true,
        stepBatch: 5,
        progressUpdates: true,
      })),
    };

    const subscriber = new AgentStatusSubscriber(
      eventBus,
      createMinimalDeps(),
      messageHub as any,
      channelBridgeManager as any,
    );

    // Register qqbot session (source channel)
    subscriber.registerSession('session-mirror', {
      channel: 'qqbot',
      envelopeId: 'env-mirror',
      userId: 'user-mirror',
    });

    // Register openclaw-weixin session (mirror target)
    subscriber.registerSession('session-weixin', {
      channel: 'openclaw-weixin',
      envelopeId: 'env-weixin',
      userId: 'user-weixin',
    });

    // Send a body update on the qqbot session
    await subscriber.sendBodyUpdate('session-mirror', 'finger-system-agent', '已删除 5 条记忆。');
    // Send the same body again (deduped on qqbot session)
    await subscriber.sendBodyUpdate('session-mirror', 'finger-system-agent', '已删除 5 条记忆。');

    // AgentStatusSubscriber should only send once to channel-bridge-qqbot
    // The mirror to openclaw-weixin is handled by ChannelBridgeManager, not here.
    const qqbotBodyCalls = routeCalls.filter(
      (c) => c.outputId === 'channel-bridge-qqbot' && c.content.startsWith('正文：'),
    );
    expect(qqbotBodyCalls).toHaveLength(1);
    expect(qqbotBodyCalls[0].content).toBe('正文：已删除 5 条记忆。');

    // openclaw-weixin should NOT receive body updates from the qqbot session via this path
    const weixinBodyCalls = routeCalls.filter(
      (c) => c.outputId === 'channel-bridge-openclaw-weixin' && c.content.startsWith('正文：'),
    );
    expect(weixinBodyCalls).toHaveLength(0);
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
    // Must enable reasoning and bodyUpdates explicitly (no longer hard-coded for qqbot)
    const channelBridgeManager = {
      getPushSettings: vi.fn().mockReturnValue({
        reasoning: true,
        bodyUpdates: true,
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
        content: '思考：继续输出思考',
      }),
    );
    expect(messageHub.routeToOutput).toHaveBeenNthCalledWith(
      2,
      'channel-bridge-qqbot',
      expect.objectContaining({
        content: '正文：继续输出正文',
      }),
    );

    subscriber.stop();
  });
});
