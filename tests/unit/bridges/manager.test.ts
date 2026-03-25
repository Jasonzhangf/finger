import { describe, it, expect, vi } from 'vitest';
import { ChannelBridgeManager } from '../../../src/bridges/manager.js';

describe('ChannelBridgeManager', () => {
  it('serializes outbound sends for the same bridge target', async () => {
    const manager = new ChannelBridgeManager({
      onMessage: vi.fn(),
      onReady: vi.fn(),
      onError: vi.fn(),
    });

    const releaseFirst = Promise.withResolvers<void>();
    const callOrder: string[] = [];

    manager['bridges'].set('openclaw-weixin', {
      id: 'openclaw-weixin',
      channelId: 'openclaw-weixin',
      start: vi.fn(),
      stop: vi.fn(),
      isRunning: vi.fn(() => true),
      sendMessage: vi.fn(async (options: { text?: string }) => {
        const text = options.text ?? '';
        callOrder.push(`start:${text}`);
        if (text === 'first') {
          await releaseFirst.promise;
        }
        callOrder.push(`end:${text}`);
        return { messageId: `msg-${text}` };
      }),
    } as any);

    manager['configs'].set('openclaw-weixin', {
      id: 'openclaw-weixin',
      channelId: 'openclaw-weixin',
      type: 'openclaw-plugin',
      enabled: true,
      credentials: {},
      options: {},
    } as any);

    const firstPromise = manager.sendMessage('openclaw-weixin', {
      to: 'user-1',
      text: 'first',
    });
    const secondPromise = manager.sendMessage('openclaw-weixin', {
      to: 'user-1',
      text: 'second',
    });

    await vi.waitFor(() => {
      expect(callOrder).toEqual(['start:first']);
    });

    releaseFirst.resolve();

    await expect(firstPromise).resolves.toEqual({ messageId: 'msg-first' });
    await expect(secondPromise).resolves.toEqual({ messageId: 'msg-second' });
    expect(callOrder).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });
});
