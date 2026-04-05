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
});
