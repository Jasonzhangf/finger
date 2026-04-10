import { describe, expect, it, vi } from 'vitest';
import {
  finalizeChannelTurnDelivery,
  type SubscriberRouteState,
} from '../../../src/server/modules/agent-status-subscriber-session-utils';
import type { PushSettings } from '../../../src/bridges/types';

function createPushSettings(overrides?: Partial<PushSettings>): PushSettings {
  return {
    updateMode: 'both',
    reasoning: true,
    bodyUpdates: true,
    statusUpdate: true,
    toolCalls: true,
    stepUpdates: true,
    stepBatch: 1,
    progressUpdates: true,
    ...(overrides ?? {}),
  };
}

function createRouteState(): SubscriberRouteState {
  return {
    sessionEnvelopeMap: new Map(),
    sessionObserverMap: new Map(),
    lastProgressMailboxSummaryBySession: new Map(),
    lastReasoningPushAtByRoute: new Map(),
  };
}

describe('agent-status-subscriber-session-utils finalizeChannelTurnDelivery', () => {
  it('respects push settings: no finalize push when bodyUpdates/statusUpdate both disabled', async () => {
    const state = createRouteState();
    state.sessionEnvelopeMap.set('session-1', {
      sessionId: 'session-1',
      envelope: {
        channel: 'qqbot',
        envelopeId: 'env-1',
        userId: 'u-1',
      },
      timestamp: Date.now(),
    });
    const routeToOutput = vi.fn(async () => undefined);
    await finalizeChannelTurnDelivery({
      sessionId: 'session-1',
      finalReply: 'done',
      finishReason: 'stop',
      agentId: 'finger-system-agent',
      deps: { sessionManager: { getSession: () => null } } as any,
      state,
      messageHub: { routeToOutput } as any,
      resolveEnvelopeMapping: () => ({
        sessionId: 'session-1',
        envelope: {
          channel: 'qqbot',
          envelopeId: 'env-1',
          userId: 'u-1',
        },
        timestamp: Date.now(),
      }),
      resolvePushSettings: () => createPushSettings({
        bodyUpdates: false,
        statusUpdate: false,
      }),
    });
    expect(routeToOutput).not.toHaveBeenCalled();
    expect(state.sessionEnvelopeMap.has('session-1')).toBe(false);
  });

  it('allows final reply push but blocks stop notice when only bodyUpdates enabled', async () => {
    const state = createRouteState();
    state.sessionEnvelopeMap.set('session-2', {
      sessionId: 'session-2',
      envelope: {
        channel: 'qqbot',
        envelopeId: 'env-2',
        userId: 'u-2',
      },
      timestamp: Date.now(),
    });
    state.sessionObserverMap.set('session-2', [
      {
        channel: 'qqbot',
        envelopeId: 'env-2-observer',
        userId: 'u-2',
      },
    ]);
    const routeToOutput = vi.fn(async () => undefined);
    await finalizeChannelTurnDelivery({
      sessionId: 'session-2',
      finalReply: 'ship it',
      finishReason: 'stop',
      agentId: 'finger-project-agent',
      deps: { sessionManager: { getSession: () => null } } as any,
      state,
      messageHub: { routeToOutput } as any,
      resolveEnvelopeMapping: () => ({
        sessionId: 'session-2',
        envelope: {
          channel: 'qqbot',
          envelopeId: 'env-2',
          userId: 'u-2',
        },
        timestamp: Date.now(),
      }),
      resolvePushSettings: () => createPushSettings({
        bodyUpdates: true,
        statusUpdate: false,
      }),
    });

    expect(routeToOutput).toHaveBeenCalledTimes(1);
    const content = routeToOutput.mock.calls[0]?.[1]?.content as string;
    expect(content).toContain('ship it');
    expect(content).not.toContain('本轮推理已结束');
  });

  it('does not auto-close fresh active project task state on no-actionable watchdog text', async () => {
    const state = createRouteState();
    state.sessionEnvelopeMap.set('session-3', {
      sessionId: 'session-3',
      envelope: {
        channel: 'qqbot',
        envelopeId: 'env-3',
        userId: 'u-3',
      },
      timestamp: Date.now(),
    });
    const updateContext = vi.fn(() => true);
    await finalizeChannelTurnDelivery({
      sessionId: 'session-3',
      finalReply: 'No actionable work. stale watchdog phantom entries already complete.',
      finishReason: 'stop',
      agentId: 'finger-project-agent',
      deps: {
        sessionManager: {
          getSession: () => ({
            context: {
              projectTaskState: {
                active: true,
                status: 'in_progress',
                sourceAgentId: 'finger-system-agent',
                targetAgentId: 'finger-project-agent',
                updatedAt: new Date().toISOString(),
                note: 'system_dispatched_project_task',
              },
            },
          }),
          updateContext,
        },
      } as any,
      state,
      messageHub: { routeToOutput: vi.fn(async () => undefined) } as any,
      resolveEnvelopeMapping: () => ({
        sessionId: 'session-3',
        envelope: {
          channel: 'qqbot',
          envelopeId: 'env-3',
          userId: 'u-3',
        },
        timestamp: Date.now(),
      }),
      resolveSourceType: () => 'clock',
      resolvePushSettings: () => createPushSettings(),
    });

    expect(updateContext).not.toHaveBeenCalled();
  });

  it('falls back to direct bridge send when finalize output is not registered', async () => {
    const state = createRouteState();
    state.sessionEnvelopeMap.set('session-fallback-finalize', {
      sessionId: 'session-fallback-finalize',
      envelope: {
        channel: 'qqbot',
        envelopeId: 'env-fallback-finalize',
        userId: 'u-fallback-finalize',
      },
      timestamp: Date.now(),
    });
    state.sessionObserverMap.set('session-fallback-finalize', [
      {
        channel: 'qqbot',
        envelopeId: 'env-fallback-finalize-observer',
        userId: 'u-fallback-finalize',
      },
    ]);
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'm-finalize-fallback' });
    const routeToOutput = vi.fn();
    await finalizeChannelTurnDelivery({
      sessionId: 'session-fallback-finalize',
      finalReply: 'done',
      finishReason: 'stop',
      agentId: 'finger-system-agent',
      deps: { sessionManager: { getSession: () => null } } as any,
      state,
      messageHub: {
        getOutputs: () => [],
        routeToOutput,
      } as any,
      channelBridgeManager: {
        getConfig: () => ({ id: 'qqbot', enabled: true }),
        sendMessage,
        startBridge: vi.fn().mockResolvedValue(undefined),
      } as any,
      resolveEnvelopeMapping: () => ({
        sessionId: 'session-fallback-finalize',
        envelope: {
          channel: 'qqbot',
          envelopeId: 'env-fallback-finalize',
          userId: 'u-fallback-finalize',
        },
        timestamp: Date.now(),
      }),
      resolvePushSettings: () => createPushSettings({
        bodyUpdates: true,
        statusUpdate: false,
      }),
    });

    expect(routeToOutput).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('qqbot', expect.objectContaining({
      to: 'u-fallback-finalize',
      replyTo: 'env-fallback-finalize-observer',
    }));
  });
});
