import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendChatCodexTurn } from '../../../src/cli/chat-codex.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('chat-codex cli', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns response text on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        messageId: 'msg-1',
        status: 'completed',
        result: {
          success: true,
          response: 'TEST_OK',
        },
      }),
    });

    const response = await sendChatCodexTurn('http://localhost:9999', 'chat-codex-gateway', 'hello');

    expect(response).toBe('TEST_OK');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callOptions = mockFetch.mock.calls[0][1] as { body: string };
    const body = JSON.parse(callOptions.body) as {
      target: string;
      message: { text: string };
      blocking: boolean;
    };

    expect(body.target).toBe('chat-codex-gateway');
    expect(body.message.text).toBe('hello');
    expect(body.blocking).toBe(true);
  });

  it('throws when module returns failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        result: {
          success: false,
          error: 'kernel failed',
        },
      }),
    });

    await expect(sendChatCodexTurn('http://localhost:9999', 'chat-codex-gateway', 'hello')).rejects.toThrow(
      'kernel failed',
    );
  });

  it('throws when daemon response is malformed', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ result: 'unexpected' }),
    });

    await expect(sendChatCodexTurn('http://localhost:9999', 'chat-codex-gateway', 'hello')).rejects.toThrow(
      'Unexpected response format from daemon',
    );
  });

  it('accepts gateway output wrapper', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        result: {
          output: {
            success: true,
            response: 'WRAPPED_OK',
          },
        },
      }),
    });

    const response = await sendChatCodexTurn('http://localhost:9999', 'chat-codex-gateway', 'hello');
    expect(response).toBe('WRAPPED_OK');
  });
});
