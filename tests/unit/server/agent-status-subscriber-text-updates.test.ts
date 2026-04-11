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

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1_000,
  intervalMs = 10,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitForCondition timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('AgentStatusSubscriber text updates', () => {
  it('qqbot 下 reasoning 后正文应有缓冲间隔，不应与思考同刻推送', async () => {
    vi.useFakeTimers();
    const prevBuffer = process.env.FINGER_REASONING_BODY_BUFFER_MS;
    process.env.FINGER_REASONING_BODY_BUFFER_MS = '200';
    try {
      const eventBus = new UnifiedEventBus();
      const routeCalls: Array<{ outputId: string; content: string }> = [];
      const messageHub = {
        routeToOutput: vi.fn().mockImplementation((outputId: string, msg: any) => {
          routeCalls.push({ outputId, content: msg.content });
          return Promise.resolve();
        }),
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
      subscriber.registerSession('session-buffer-gap', {
        channel: 'qqbot',
        envelopeId: 'env-buffer-gap',
        userId: 'user-buffer-gap',
      });

      await subscriber.sendReasoningUpdate('session-buffer-gap', 'finger-system-agent', '先检查上下文');
      expect(routeCalls).toHaveLength(1);
      expect(routeCalls[0].content).toBe('思考：先检查上下文');

      const bodyPromise = subscriber.sendBodyUpdate('session-buffer-gap', 'finger-system-agent', '这是正文结果');
      await Promise.resolve();
      expect(routeCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(199);
      expect(routeCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await bodyPromise;
      expect(routeCalls).toHaveLength(2);
      expect(routeCalls[1].content).toBe('正文：这是正文结果');
    } finally {
      process.env.FINGER_REASONING_BODY_BUFFER_MS = prevBuffer;
      vi.useRealTimers();
    }
  });

  it('applies update-stream policy before channel pushSettings for qqbot', async () => {
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

    // Merge priority: session > update-stream > channel pushSettings.
    // With default update-stream policy, qqbot still emits reasoning/body.
    await subscriber.sendReasoningUpdate('session-qq', 'finger-system-agent', '先检查日志');
    await subscriber.sendBodyUpdate('session-qq', 'finger-system-agent', '正文增量');

    expect(messageHub.routeToOutput).toHaveBeenCalledTimes(2);
    expect(messageHub.routeToOutput).toHaveBeenNthCalledWith(
      1,
      'channel-bridge-qqbot',
      expect.objectContaining({ content: '思考：先检查日志' }),
    );
    expect(messageHub.routeToOutput).toHaveBeenNthCalledWith(
      2,
      'channel-bridge-qqbot',
      expect.objectContaining({ content: '正文：正文增量' }),
    );
  });

  it('falls back to direct bridge send when channel output is not registered', async () => {
    const eventBus = new UnifiedEventBus();
    const messageHub = {
      getOutputs: vi.fn(() => []),
      routeToOutput: vi.fn().mockRejectedValue(new Error('Output channel-bridge-qqbot not registered')),
    };
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'm-fallback-text' });
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
      getConfig: vi.fn().mockReturnValue({ id: 'qqbot', enabled: true }),
      sendMessage,
      startBridge: vi.fn().mockResolvedValue(undefined),
    };

    const subscriber = new AgentStatusSubscriber(
      eventBus,
      createMinimalDeps(),
      messageHub as any,
      channelBridgeManager as any,
    );
    subscriber.registerSession('session-direct-fallback', {
      channel: 'qqbot',
      envelopeId: 'env-direct-fallback',
      userId: 'user-direct-fallback',
    });

    await subscriber.sendBodyUpdate('session-direct-fallback', 'finger-system-agent', '正文增量');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('qqbot', expect.objectContaining({
      to: 'user-direct-fallback',
      replyTo: 'env-direct-fallback',
      text: '正文：正文增量',
    }));
    expect(messageHub.routeToOutput).not.toHaveBeenCalled();
  });

  it('applies update-stream policy before channel pushSettings for webui', async () => {
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

    expect(messageHub.routeToOutput).toHaveBeenCalledTimes(2);
    expect(messageHub.routeToOutput).toHaveBeenNthCalledWith(
      1,
      'channel-bridge-webui',
      expect.objectContaining({ content: '思考：不会推送' }),
    );
    expect(messageHub.routeToOutput).toHaveBeenNthCalledWith(
      2,
      'channel-bridge-webui',
      expect.objectContaining({ content: '正文：不会推送' }),
    );
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

  it('strips control json block from user-facing body update', async () => {
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
    subscriber.registerSession('session-control-strip', {
      channel: 'qqbot',
      envelopeId: 'env-control-strip',
      userId: 'user-control-strip',
    });

    const body = [
      'Jason，已完成修复。',
      '```json',
      JSON.stringify({
        schema_version: '1.0',
        task_completed: true,
        evidence_ready: true,
        needs_user_input: false,
        has_blocker: false,
        dispatch_required: false,
        review_required: false,
        wait: { enabled: false, seconds: 0, reason: '' },
        user_signal: { negative_score: 0, profile_update_required: false, why: '' },
        tags: ['debug', 'fix'],
        self_eval: { score: 90, confidence: 90, goal_gap: '', why: 'done' },
        anti_patterns: [],
        learning: {
          did_right: [],
          did_wrong: [],
          repeated_wrong: [],
          flow_patch: { required: false, project_scope: '', changes: [] },
          memory_patch: { required: false, project_scope: '', long_term_items: [], short_term_items: [] },
          user_profile_patch: { required: false, items: [], sensitivity: 'normal' },
        },
      }),
      '```',
    ].join('\n');

    await subscriber.sendBodyUpdate('session-control-strip', 'finger-system-agent', body);
    expect(messageHub.routeToOutput).toHaveBeenCalledTimes(1);
    const payload = messageHub.routeToOutput.mock.calls[0][1];
    expect(payload.content).toBe('正文：Jason，已完成修复。');
    expect(payload.content).not.toContain('schema_version');
  });

  it('strips malformed control-like json fence from user-facing body update', async () => {
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
    subscriber.registerSession('session-control-strip-2', {
      channel: 'qqbot',
      envelopeId: 'env-control-strip-2',
      userId: 'user-control-strip-2',
    });

    const malformed = [
      'Jason，根因已定位。',
      '```json',
      '{',
      '  "schema_version": "1.3",',
      '  "task_completed": false,',
      '  "needs_user_input": false,',
      '  "dispatch_required": false,',
      '  "review_required": false,',
      '  "self_eval": "ok",',
      '  "learning": "candidate",',
      '  // malformed comment should make parser fail',
      '}',
      '```',
    ].join('\n');

    await subscriber.sendBodyUpdate('session-control-strip-2', 'finger-system-agent', malformed);
    expect(messageHub.routeToOutput).toHaveBeenCalledTimes(1);
    const payload = messageHub.routeToOutput.mock.calls[0][1];
    expect(payload.content).toBe('正文：Jason，根因已定位。');
    expect(payload.content).not.toContain('schema_version');
    expect(payload.content).not.toContain('task_completed');
  });

  it('strips tool_calls json payload and keeps only human body', async () => {
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
    subscriber.registerSession('session-control-strip-tool-calls', {
      channel: 'qqbot',
      envelopeId: 'env-control-strip-tool-calls',
      userId: 'user-control-strip-tool-calls',
    });

    const body = [
      'Jason，重启恢复确认。',
      '```json{"tool_calls":[{"name":"mailbox.status","input":{"target":"finger-system-agent"}},{"name":"mailbox.list","input":{"target":"finger-system-agent","unreadOnly":true}}]}```',
    ].join('\n');

    await subscriber.sendBodyUpdate('session-control-strip-tool-calls', 'finger-system-agent', body);
    expect(messageHub.routeToOutput).toHaveBeenCalledTimes(1);
    const payload = messageHub.routeToOutput.mock.calls[0][1];
    expect(payload.content).toBe('正文：Jason，重启恢复确认。');
    expect(payload.content).not.toContain('tool_calls');
    expect(payload.content).not.toContain('mailbox.status');
  });

  it('drops pure tool_calls json body with no human text', async () => {
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
    subscriber.registerSession('session-control-strip-tool-calls-only', {
      channel: 'qqbot',
      envelopeId: 'env-control-strip-tool-calls-only',
      userId: 'user-control-strip-tool-calls-only',
    });

    const body = '{"tool_calls":[{"name":"mailbox.status","input":{"target":"finger-system-agent"}},{"name":"mailbox.list","input":{"target":"finger-system-agent","unreadOnly":true}}]}';
    await subscriber.sendBodyUpdate('session-control-strip-tool-calls-only', 'finger-system-agent', body);
    expect(messageHub.routeToOutput).toHaveBeenCalledTimes(0);
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

  it('pushes same-session text updates to multiple channel observers', async () => {
    const eventBus = new UnifiedEventBus();
    const routeCalls: Array<{ outputId: string; content: string }> = [];
    const messageHub = {
      routeToOutput: vi.fn().mockImplementation((outputId: string, msg: any) => {
        routeCalls.push({ outputId, content: msg.content });
        return Promise.resolve();
      }),
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
    subscriber.registerSession('session-shared', {
      channel: 'openclaw-weixin',
      envelopeId: 'env-wx',
      userId: 'user-wx',
    });
    subscriber.registerSession('session-shared', {
      channel: 'qqbot',
      envelopeId: 'env-qq',
      userId: 'user-qq',
    });

    await subscriber.sendBodyUpdate('session-shared', 'finger-system-agent', '同一轮正文');

    expect(routeCalls).toEqual([
      { outputId: 'channel-bridge-openclaw-weixin', content: '正文：同一轮正文' },
      { outputId: 'channel-bridge-qqbot', content: '正文：同一轮正文' },
    ]);
  });

  it('finalizes same-session observer replies on turn completion', async () => {
    const eventBus = new UnifiedEventBus();
    const routeCalls: Array<{ outputId: string; content: string }> = [];
    const messageHub = {
      routeToOutput: vi.fn().mockImplementation((outputId: string, msg: any) => {
        routeCalls.push({ outputId, content: msg.content });
        return Promise.resolve();
      }),
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
    subscriber.registerSession('session-finalize', {
      channel: 'openclaw-weixin',
      envelopeId: 'env-primary',
      userId: 'user-primary',
    });
    subscriber.registerSession('session-finalize', {
      channel: 'qqbot',
      envelopeId: 'env-observer',
      userId: 'user-observer',
    });

    await subscriber.finalizeChannelTurn('session-finalize', '最终结果', 'finger-system-agent');

    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0].outputId).toBe('channel-bridge-qqbot');
    expect(routeCalls[0].content).toContain('最终结果');

    routeCalls.length = 0;
    await subscriber.sendBodyUpdate('session-finalize', 'finger-system-agent', '不会再推送');
    expect(routeCalls).toHaveLength(0);
  });

  it('suppresses scheduled no-action watchdog body updates', async () => {
    const eventBus = new UnifiedEventBus();
    const routeCalls: Array<{ outputId: string; content: string }> = [];
    const messageHub = {
      routeToOutput: vi.fn().mockImplementation((outputId: string, msg: any) => {
        routeCalls.push({ outputId, content: String(msg.content ?? '') });
        return Promise.resolve();
      }),
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
    const deps = createMinimalDeps();
    (deps.sessionManager.getSession as any) = vi.fn((sessionId: string) => {
      if (sessionId === 'session-noop-watchdog') {
        return {
          context: {
            source: 'system-heartbeat',
            scheduledProgressDelivery: { mode: 'result_only' },
          },
        };
      }
      return null;
    });

    const subscriber = new AgentStatusSubscriber(
      eventBus,
      deps,
      messageHub as any,
      channelBridgeManager as any,
    );
    subscriber.registerSession('session-noop-watchdog', {
      channel: 'qqbot',
      envelopeId: 'env-noop-watchdog',
      userId: 'user-noop-watchdog',
    });

    await subscriber.sendBodyUpdate(
      'session-noop-watchdog',
      'finger-project-agent',
      'No actionable work. This is a stale watchdog trigger from an already-completed task.',
    );

    expect(routeCalls).toHaveLength(0);
  });

  it('suppresses scheduled no-action watchdog body updates (zh variants)', async () => {
    const eventBus = new UnifiedEventBus();
    const routeCalls: Array<{ outputId: string; content: string }> = [];
    const messageHub = {
      routeToOutput: vi.fn().mockImplementation((outputId: string, msg: any) => {
        routeCalls.push({ outputId, content: String(msg.content ?? '') });
        return Promise.resolve();
      }),
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
    const deps = createMinimalDeps();
    (deps.sessionManager.getSession as any) = vi.fn((sessionId: string) => {
      if (sessionId === 'session-noop-watchdog-zh') {
        return {
          context: {
            source: 'system-heartbeat',
            scheduledProgressDelivery: { mode: 'result_only' },
          },
        };
      }
      return null;
    });

    const subscriber = new AgentStatusSubscriber(
      eventBus,
      deps,
      messageHub as any,
      channelBridgeManager as any,
    );
    subscriber.registerSession('session-noop-watchdog-zh', {
      channel: 'qqbot',
      envelopeId: 'env-noop-watchdog-zh',
      userId: 'user-noop-watchdog-zh',
    });

    await subscriber.sendBodyUpdate(
      'session-noop-watchdog-zh',
      'finger-project-agent',
      '这是一个过期的监控触发器。Watchdog 误报，无待办工作。',
    );

    expect(routeCalls).toHaveLength(0);
  });

  it('suppresses scheduled no-action watchdog turn-finalization notices', async () => {
    const eventBus = new UnifiedEventBus();
    const routeCalls: Array<{ outputId: string; content: string }> = [];
    const messageHub = {
      routeToOutput: vi.fn().mockImplementation((outputId: string, msg: any) => {
        routeCalls.push({ outputId, content: String(msg.content ?? '') });
        return Promise.resolve();
      }),
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
    const deps = createMinimalDeps();
    (deps.sessionManager.getSession as any) = vi.fn((sessionId: string) => {
      if (sessionId === 'session-finalize-noop-watchdog') {
        return {
          context: {
            source: 'system-heartbeat',
            scheduledProgressDelivery: { mode: 'result_only' },
          },
        };
      }
      return null;
    });

    const subscriber = new AgentStatusSubscriber(
      eventBus,
      deps,
      messageHub as any,
      channelBridgeManager as any,
    );
    subscriber.registerSession('session-finalize-noop-watchdog', {
      channel: 'openclaw-weixin',
      envelopeId: 'env-noop-primary',
      userId: 'user-noop-primary',
    });
    subscriber.registerSession('session-finalize-noop-watchdog', {
      channel: 'qqbot',
      envelopeId: 'env-noop-observer',
      userId: 'user-noop-observer',
    });

    await subscriber.finalizeChannelTurn(
      'session-finalize-noop-watchdog',
      'No actionable work. This is a stale watchdog trigger from the already-completed task.',
      'finger-project-agent',
      'stop',
    );

    expect(routeCalls).toHaveLength(0);
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
      summary: '正在处理任务\n🧠 上下文: 41% · 53.2k/128k',
      progress: {
        status: 'running',
        toolCallsCount: 2,
        modelRoundsCount: 1,
        elapsedMs: 1234,
        contextUsagePercent: 41,
        estimatedTokensInContextWindow: 53200,
        maxInputTokens: 128000,
      },
    });

    expect(messageHub.routeToOutput).toHaveBeenCalledTimes(1);
    const [, payload] = messageHub.routeToOutput.mock.calls[0];
    expect(payload.content).toContain(`👤 [agent] ${targetAgent}`);
    expect(payload.content).toContain('📬 mailbox.status(');
    expect(payload.content).toContain('🧠 上下文: 41% · 53.2k/128k');
    expect(payload.content).toContain(`mailbox.status(${targetAgent}): unread=2 pending=2 processing=0`);
    expect(payload.statusUpdate.status.details.agentRole).toBe('agent');
    expect(payload.statusUpdate.status.details.mailboxStatus.counts.unread).toBe(2);
    expect(payload.statusUpdate.status.details.contextUsagePercent).toBe(41);
    expect(payload.statusUpdate.status.details.estimatedTokensInContextWindow).toBe(53200);
    expect(payload.statusUpdate.status.details.maxInputTokens).toBe(128000);

    heartbeatMailbox.removeAll(targetAgent);
  });

  it('appends inferred context ratio and size to progress updates when only percent is available', async () => {
    const eventBus = new UnifiedEventBus();
    const messageHub = {
      routeToOutput: vi.fn(async () => undefined),
    };
    const channelBridgeManager = {
      getPushSettings: vi.fn(() => ({
        statusUpdate: true,
        bodyUpdates: true,
        reasoning: true,
        progressUpdates: true,
      })),
    };

    const subscriber = new AgentStatusSubscriber(
      eventBus,
      createMinimalDeps(),
      messageHub as any,
      channelBridgeManager as any,
    );
    subscriber.registerSession('session-progress-fallback', {
      channel: 'qqbot',
      envelopeId: 'env-progress-fallback',
      userId: 'user-progress-fallback',
    });

    await subscriber.sendProgressUpdate({
      sessionId: 'session-progress-fallback',
      agentId: 'finger-system-agent',
      summary: '正在处理任务',
      progress: {
        status: 'running',
        toolCallsCount: 1,
        modelRoundsCount: 1,
        elapsedMs: 1200,
        contextUsagePercent: 50,
      },
    });

    expect(messageHub.routeToOutput).toHaveBeenCalledTimes(1);
    const [, payload] = messageHub.routeToOutput.mock.calls[0];
    expect(payload.content).toMatch(/👤 \[system\] (Mirror\(finger-system-agent\)|finger-system-agent)/);
    expect(payload.content).toContain('🧠 上下文: 50% · ~131k/262k');
    expect(payload.statusUpdate.status.details.agentRole).toBe('system');
    expect(payload.statusUpdate.status.details.maxInputTokens).toBe(262144);
  });

  it('routes child project-session progress after dispatch and keeps role marker', async () => {
    const eventBus = new UnifiedEventBus();
    const routeCalls: Array<{ outputId: string; content: string }> = [];
    const messageHub = {
      routeToOutput: vi.fn().mockImplementation((outputId: string, msg: any) => {
        routeCalls.push({ outputId, content: String(msg.content ?? '') });
        return Promise.resolve();
      }),
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
    subscriber.registerSession('session-root', {
      channel: 'qqbot',
      envelopeId: 'env-root',
      userId: 'user-root',
    });
    subscriber.setPrimaryAgent('finger-system-agent');
    subscriber.start();

    await eventBus.emit({
      type: 'agent_dispatch_queued',
      sessionId: 'session-root',
      timestamp: new Date().toISOString(),
      payload: {
        dispatchId: 'dispatch-child-progress',
        sourceAgentId: 'finger-system-agent',
        targetAgentId: 'finger-project-agent',
        childSessionId: 'session-project-1',
        status: 'running',
      },
    } as RuntimeEvent);
    await new Promise((resolve) => setTimeout(resolve, 20));

    routeCalls.length = 0;
    await subscriber.sendProgressUpdate({
      sessionId: 'session-project-1',
      agentId: 'finger-project-agent',
      summary: '📊 12:11 | 执行中\n🧭 rg → ✅',
      progress: {
        status: 'running',
        toolCallsCount: 2,
        modelRoundsCount: 1,
        elapsedMs: 1100,
      },
    });

    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0].outputId).toBe('channel-bridge-qqbot');
    expect(routeCalls[0].content).toMatch(/👤 \[project\] (Alex\(finger-project-agent\)|finger-project-agent)/);
    expect(routeCalls[0].content).toMatch(/🧭 rg →\s*✅/);

    subscriber.stop();
  });

  it('does not repeat unchanged mailbox.status summary in next progress update', async () => {
    const eventBus = new UnifiedEventBus();
    const routeCalls: Array<{ outputId: string; content: string }> = [];
    const messageHub = {
      routeToOutput: vi.fn().mockImplementation((outputId: string, msg: any) => {
        routeCalls.push({ outputId, content: msg.content });
        return Promise.resolve();
      }),
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

    const targetAgent = `agent-mailbox-dedup-${Date.now()}`;
    heartbeatMailbox.append(targetAgent, { text: 'mailbox task' }, { category: 'task', priority: 1 });

    const subscriber = new AgentStatusSubscriber(
      eventBus,
      createMinimalDeps(),
      messageHub as any,
      channelBridgeManager as any,
    );
    subscriber.registerSession('session-mailbox-dedup', {
      channel: 'qqbot',
      envelopeId: 'env-mailbox-dedup',
      userId: 'user-mailbox-dedup',
    });

    await subscriber.sendProgressUpdate({
      sessionId: 'session-mailbox-dedup',
      agentId: targetAgent,
      summary: '第一次进度',
      progress: {
        status: 'running',
        toolCallsCount: 1,
        modelRoundsCount: 1,
        elapsedMs: 1000,
      },
    });

    await subscriber.sendProgressUpdate({
      sessionId: 'session-mailbox-dedup',
      agentId: targetAgent,
      summary: '第二次进度',
      progress: {
        status: 'running',
        toolCallsCount: 2,
        modelRoundsCount: 1,
        elapsedMs: 2000,
      },
    });

    await waitForCondition(() => routeCalls.length >= 2);
    expect(routeCalls).toHaveLength(2);
    expect(routeCalls[0].content).toContain('📬 mailbox.status(');
    expect(routeCalls[1].content).toContain('第二次进度');
    expect(routeCalls[1].content).not.toContain('📬 mailbox.status(');

    heartbeatMailbox.removeAll(targetAgent);
  });

  it('broadcasts progress updates to all same-session observers', async () => {
    const eventBus = new UnifiedEventBus();
    const routeCalls: Array<{ outputId: string; content: string }> = [];
    const messageHub = {
      routeToOutput: vi.fn().mockImplementation((outputId: string, msg: any) => {
        routeCalls.push({ outputId, content: msg.content });
        return Promise.resolve();
      }),
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
    subscriber.registerSession('session-progress-shared', {
      channel: 'openclaw-weixin',
      envelopeId: 'env-progress-wx',
      userId: 'user-progress-wx',
    });
    subscriber.registerSession('session-progress-shared', {
      channel: 'qqbot',
      envelopeId: 'env-progress-qq',
      userId: 'user-progress-qq',
    });

    await subscriber.sendProgressUpdate({
      sessionId: 'session-progress-shared',
      agentId: 'finger-system-agent',
      summary: '正在共同观察同一轮进度',
      progress: {
        status: 'running',
        toolCallsCount: 3,
        modelRoundsCount: 2,
        elapsedMs: 4321,
      },
    });

    expect(routeCalls).toHaveLength(2);
    expect(routeCalls[0].outputId).toBe('channel-bridge-openclaw-weixin');
    expect(routeCalls[0].content).toContain('正在共同观察同一轮进度');
    expect(routeCalls[1].outputId).toBe('channel-bridge-qqbot');
    expect(routeCalls[1].content).toContain('正在共同观察同一轮进度');
  });

  it('broadcasts runtime status updates to all same-session observers', async () => {
    const eventBus = new UnifiedEventBus();
    const routeCalls: Array<{ outputId: string; content: string }> = [];
    const messageHub = {
      routeToOutput: vi.fn().mockImplementation((outputId: string, msg: any) => {
        routeCalls.push({ outputId, content: msg.content });
        return Promise.resolve();
      }),
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
    subscriber.registerSession('session-runtime-shared', {
      channel: 'openclaw-weixin',
      envelopeId: 'env-runtime-wx',
      userId: 'user-runtime-wx',
    });
    subscriber.registerSession('session-runtime-shared', {
      channel: 'qqbot',
      envelopeId: 'env-runtime-qq',
      userId: 'user-runtime-qq',
    });
    subscriber.setPrimaryAgent('finger-system-agent');
    subscriber.start();

    const runningEvent: RuntimeEvent = {
      type: 'agent_runtime_status',
      sessionId: 'session-runtime-shared',
      timestamp: new Date().toISOString(),
      payload: {
        scope: 'session',
        status: 'running',
        agentId: 'finger-system-agent',
        summary: '系统正在处理同一轮输入',
      },
    };
    await eventBus.emit(runningEvent);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(routeCalls).toHaveLength(2);
    expect(routeCalls[0].outputId).toBe('channel-bridge-openclaw-weixin');
    expect(routeCalls[0].content).toContain('系统正在处理同一轮输入');
    expect(routeCalls[1].outputId).toBe('channel-bridge-qqbot');
    expect(routeCalls[1].content).toContain('系统正在处理同一轮输入');

    subscriber.stop();
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
