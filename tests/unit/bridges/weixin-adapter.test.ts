import { describe, it, expect, vi } from 'vitest';
import { WeixinBridgeAdapter } from '../../../src/bridges/weixin-adapter.js';

describe('WeixinBridgeAdapter', () => {
  it('does not block polling thread while downstream onMessage is still running', async () => {
    const onMessage = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    const adapter = new WeixinBridgeAdapter({
      id: 'openclaw-weixin',
      channelId: 'openclaw-weixin',
      credentials: {
        accountId: 'test-account',
      },
    } as any, {
      onMessage,
      onReady: vi.fn(),
      onError: vi.fn(),
    });

    const start = Date.now();
    await (adapter as any).handleMessage({
      message_type: 1,
      message_id: 123,
      from_user_id: 'wx-user-1',
      session_id: 'wx-session-1',
      create_time_ms: Date.now(),
      item_list: [
        {
          type: 1,
          text_item: {
            text: '你看到图了吗？',
          },
        },
      ],
      context_token: 'ctx-1',
    });
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(40);
    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledTimes(1);
    });

    await vi.waitFor(() => {
      expect((adapter as any).inboundQueues.size).toBe(0);
    });
  });

  it('serializes inbound delivery for the same sender like qqbot per-user processor', async () => {
    const order: string[] = [];
    const releaseFirst = Promise.withResolvers<void>();
    const onMessage = vi.fn().mockImplementation(async (message: { content: string }) => {
      order.push(`start:${message.content}`);
      if (message.content === 'first') {
        await releaseFirst.promise;
      }
      order.push(`end:${message.content}`);
    });

    const adapter = new WeixinBridgeAdapter({
      id: 'openclaw-weixin',
      channelId: 'openclaw-weixin',
      credentials: {
        accountId: 'test-account',
      },
    } as any, {
      onMessage,
      onReady: vi.fn(),
      onError: vi.fn(),
    });

    await (adapter as any).handleMessage({
      message_type: 1,
      message_id: 201,
      from_user_id: 'wx-user-2',
      session_id: 'wx-session-2',
      create_time_ms: Date.now(),
      item_list: [{ type: 1, text_item: { text: 'first' } }],
    });

    await (adapter as any).handleMessage({
      message_type: 1,
      message_id: 202,
      from_user_id: 'wx-user-2',
      session_id: 'wx-session-2',
      create_time_ms: Date.now(),
      item_list: [{ type: 1, text_item: { text: 'second' } }],
    });

    await vi.waitFor(() => {
      expect(order).toEqual(['start:first']);
    });

    releaseFirst.resolve();

    await vi.waitFor(() => {
      expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
    });
  });
});
