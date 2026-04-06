import { describe, expect, it, vi } from 'vitest';
import { sendStatusUpdate } from '../../../src/server/modules/agent-status-subscriber-runtime.js';

function makeStatusUpdate(summary: string) {
  return {
    type: 'agent_status',
    eventId: 'evt-1',
    timestamp: new Date().toISOString(),
    sessionId: 'session-1',
    agent: { agentId: 'finger-system-agent' },
    task: { taskDescription: 'task' },
    status: {
      state: 'running',
      summary,
      details: {
        sourceType: 'heartbeat',
      },
    },
    display: {
      title: '📊 进度更新',
      subtitle: '',
      icon: '🔄',
      level: 'detailed',
    },
  } as any;
}

describe('agent status display settings', () => {
  it('suppresses heartbeat update when heartbeat display is off', async () => {
    const routeToOutput = vi.fn();
    const messageHub = {
      getOutputs: () => [{ id: 'channel-bridge-qqbot' }],
      routeToOutput,
    } as any;
    const channelBridgeManager = {
      getPushSettings: () => ({ statusUpdate: true }),
      getConfig: () => ({ options: { displaySettings: { heartbeat: false } } }),
    } as any;

    await sendStatusUpdate({
      channel: 'qqbot',
      envelopeId: 'env-1',
      userId: 'u1',
    } as any, makeStatusUpdate('👤 [system agent:hb] finger-system-agent\n🧠 上下文: 30%'), messageHub, channelBridgeManager);

    expect(routeToOutput).not.toHaveBeenCalled();
  });

  it('removes context lines when ctx display is off', async () => {
    const routeToOutput = vi.fn();
    const messageHub = {
      getOutputs: () => [{ id: 'channel-bridge-qqbot' }],
      routeToOutput,
    } as any;
    const channelBridgeManager = {
      getPushSettings: () => ({ statusUpdate: true }),
      getConfig: () => ({ options: { displaySettings: { context: 'off', heartbeat: true } } }),
    } as any;

    await sendStatusUpdate({
      channel: 'qqbot',
      envelopeId: 'env-2',
      userId: 'u1',
    } as any, makeStatusUpdate('👤 [system] finger-system-agent\n🧠 上下文: 30%\n🧩 构成: H(c=1,cur=2)\n✅ done'), messageHub, channelBridgeManager);

    expect(routeToOutput).toHaveBeenCalledTimes(1);
    const payload = routeToOutput.mock.calls[0]?.[1] as { content?: string };
    expect(payload.content).toContain('✅ done');
    expect(payload.content).not.toContain('🧠 上下文');
    expect(payload.content).not.toContain('🧩 构成');
  });

  it('keeps concise context when ctx is simple', async () => {
    const routeToOutput = vi.fn();
    const messageHub = {
      getOutputs: () => [{ id: 'channel-bridge-qqbot' }],
      routeToOutput,
    } as any;
    const channelBridgeManager = {
      getPushSettings: () => ({ statusUpdate: true }),
      getConfig: () => ({ options: { displaySettings: { context: 'simple', heartbeat: true } } }),
    } as any;

    await sendStatusUpdate({
      channel: 'qqbot',
      envelopeId: 'env-3',
      userId: 'u1',
    } as any, makeStatusUpdate('👤 [system] finger-system-agent\n🧠 上下文: 30%\n🧩 构成: H(c=1,cur=2)\n🧩 构成: I(text=1)\n✅ done'), messageHub, channelBridgeManager);

    const payload = routeToOutput.mock.calls[0]?.[1] as { content?: string };
    expect(payload.content).toContain('🧠 上下文');
    expect(payload.content).toContain('🧩 历史: context history=');
    expect(payload.content).toContain('current history=');
    expect(payload.content).not.toContain('🧩 构成: I(');
  });

  it('keeps explicit history line when ctx is simple', async () => {
    const routeToOutput = vi.fn();
    const messageHub = {
      getOutputs: () => [{ id: 'channel-bridge-qqbot' }],
      routeToOutput,
    } as any;
    const channelBridgeManager = {
      getPushSettings: () => ({ statusUpdate: true }),
      getConfig: () => ({ options: { displaySettings: { context: 'simple', heartbeat: true } } }),
    } as any;

    await sendStatusUpdate({
      channel: 'qqbot',
      envelopeId: 'env-3b',
      userId: 'u1',
    } as any, makeStatusUpdate('👤 [system] finger-system-agent\n🧠 上下文: 30%\n🧩 历史: context history=10k(3.8%) · current history=5k(1.9%)\n✅ done'), messageHub, channelBridgeManager);

    const payload = routeToOutput.mock.calls[0]?.[1] as { content?: string };
    expect(payload.content).toContain('🧠 上下文');
    expect(payload.content).toContain('🧩 历史: context history=');
    expect(payload.content).toContain('current history=');
  });

  it('falls back to direct bridge send when output is missing', async () => {
    const routeToOutput = vi.fn();
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'm-1' });
    const messageHub = {
      getOutputs: () => [],
      routeToOutput,
    } as any;
    const channelBridgeManager = {
      getPushSettings: () => ({ statusUpdate: true }),
      getConfig: () => ({ id: 'qqbot', enabled: true }),
      sendMessage,
      startBridge: vi.fn().mockResolvedValue(undefined),
    } as any;

    await sendStatusUpdate({
      channel: 'qqbot',
      envelopeId: 'env-fallback-1',
      userId: 'u-fallback-1',
    } as any, makeStatusUpdate('👤 [system] finger-system-agent\n✅ fallback'), messageHub, channelBridgeManager);

    expect(routeToOutput).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('qqbot', expect.objectContaining({
      to: 'u-fallback-1',
      replyTo: 'env-fallback-1',
    }));
  });

  it('falls back to direct bridge send when routeToOutput reports output not registered', async () => {
    const routeToOutput = vi.fn().mockRejectedValue(new Error('Output channel-bridge-qqbot not registered'));
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'm-2' });
    const messageHub = {
      getOutputs: () => [{ id: 'channel-bridge-qqbot' }],
      routeToOutput,
    } as any;
    const channelBridgeManager = {
      getPushSettings: () => ({ statusUpdate: true }),
      getConfig: () => ({ id: 'qqbot', enabled: true }),
      sendMessage,
      startBridge: vi.fn().mockResolvedValue(undefined),
    } as any;

    await sendStatusUpdate({
      channel: 'qqbot',
      envelopeId: 'env-fallback-2',
      userId: 'u-fallback-2',
    } as any, makeStatusUpdate('👤 [system] finger-system-agent\n✅ fallback'), messageHub, channelBridgeManager);

    expect(routeToOutput).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('progress mode supports non-blocking status delivery', async () => {
    const routeToOutput = vi.fn(() => new Promise(() => undefined));
    const messageHub = {
      getOutputs: () => [{ id: 'channel-bridge-qqbot' }],
      routeToOutput,
    } as any;
    const channelBridgeManager = {
      getPushSettings: () => ({ statusUpdate: true }),
      getConfig: () => ({ options: { displaySettings: { context: 'simple', heartbeat: true } } }),
    } as any;

    const result = await Promise.race([
      sendStatusUpdate(
        {
          channel: 'qqbot',
          envelopeId: 'env-non-blocking',
          userId: 'u-non-blocking',
        } as any,
        makeStatusUpdate('👤 [system] finger-system-agent\n✅ non-blocking'),
        messageHub,
        channelBridgeManager,
        { nonBlocking: true },
      ).then(() => 'done'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 30)),
    ]);

    expect(result).toBe('done');
    expect(routeToOutput).toHaveBeenCalledTimes(1);
  });
});
