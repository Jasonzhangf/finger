import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createChatCodexModule,
  type ChatCodexRunResult,
  type ChatCodexRunner,
} from '../../../src/agents/chat-codex/chat-codex-module.js';

function asRecord(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

describe('chat-codex module', () => {
  let runTurnMock: ReturnType<typeof vi.fn<[string], Promise<ChatCodexRunResult>>>;
  let runner: ChatCodexRunner;

  beforeEach(() => {
    runTurnMock = vi.fn<[string], Promise<ChatCodexRunResult>>();
    runner = {
      runTurn: runTurnMock,
    };
  });

  it('returns error when input text missing', async () => {
    const module = createChatCodexModule({}, runner);

    const result = await module.handle({ foo: 'bar' });
    const payload = asRecord(result);

    expect(payload.success).toBe(false);
    expect(payload.error).toBe('No input text provided');
    expect(runTurnMock).not.toHaveBeenCalled();
  });

  it('runs turn and returns success response', async () => {
    runTurnMock.mockResolvedValue({
      reply: 'E2E_OK',
      events: [],
      usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
    });

    const module = createChatCodexModule({}, runner);
    const callback = vi.fn<(result: unknown) => void>();
    const result = await module.handle({ text: 'hello' }, callback);
    const payload = asRecord(result);

    expect(runTurnMock).toHaveBeenCalledWith('hello');
    expect(payload.success).toBe(true);
    expect(payload.response).toBe('E2E_OK');

    expect(callback).toHaveBeenCalledTimes(1);
    const callbackPayload = asRecord(callback.mock.calls[0][0]);
    expect(callbackPayload.response).toBe('E2E_OK');
  });

  it('maps runner error to module response', async () => {
    runTurnMock.mockRejectedValue(new Error('kernel failed'));
    const module = createChatCodexModule({}, runner);

    const result = await module.handle('hello');
    const payload = asRecord(result);

    expect(payload.success).toBe(false);
    expect(payload.error).toBe('kernel failed');
  });
});

