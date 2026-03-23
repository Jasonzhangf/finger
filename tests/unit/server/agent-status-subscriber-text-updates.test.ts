import { describe, it, expect, vi } from 'vitest';
import { UnifiedEventBus } from '../../../src/runtime/event-bus.js';
import { AgentStatusSubscriber } from '../../../src/server/modules/agent-status-subscriber.js';
import type { AgentRuntimeDeps } from '../../../src/server/modules/agent-runtime/types.js';

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
        content: '思考：先检查日志',
      }),
    );
    expect(messageHub.routeToOutput).toHaveBeenNthCalledWith(
      2,
      'channel-bridge-qqbot',
      expect.objectContaining({
        content: '正文：正文增量',
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
});
