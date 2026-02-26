import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ChatCodexRunContext,
  createChatCodexModule,
  type ChatCodexRunResult,
  type ChatCodexRunner,
  type KernelInputItem,
} from '../../../src/agents/chat-codex/chat-codex-module.js';

function asRecord(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

describe('chat-codex module', () => {
  let runTurnMock: ReturnType<typeof vi.fn<[string, KernelInputItem[]?, ChatCodexRunContext?], Promise<ChatCodexRunResult>>>;
  let runner: ChatCodexRunner;

  beforeEach(() => {
    runTurnMock = vi.fn<[string, KernelInputItem[]?, ChatCodexRunContext?], Promise<ChatCodexRunResult>>();
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

    expect(runTurnMock).toHaveBeenCalledTimes(1);
    const callArgs = runTurnMock.mock.calls[0];
    expect(callArgs[0]).toBe('hello');
    expect(callArgs[1]).toBeUndefined();
    expect(callArgs[2]).toEqual(
      expect.objectContaining({
        sessionId: expect.any(String),
        systemPrompt: expect.any(String),
      }),
    );
    expect(callArgs[2]?.tools).toBeInstanceOf(Array);
    expect(callArgs[2]?.tools?.length ?? 0).toBeGreaterThan(0);
    expect(payload.success).toBe(true);
    expect(payload.response).toBe('E2E_OK');
    expect(payload.provider).toBe('codex');
    expect(typeof payload.sessionId).toBe('string');

    expect(callback).toHaveBeenCalledTimes(1);
    const callbackPayload = asRecord(callback.mock.calls[0][0]);
    expect(callbackPayload.response).toBe('E2E_OK');
  });

  it('accepts prompt field as unified input alias', async () => {
    runTurnMock.mockResolvedValue({
      reply: 'PROMPT_OK',
      events: [],
      usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
    });

    const module = createChatCodexModule({}, runner);
    const result = await module.handle({ prompt: 'alias-input' });
    const payload = asRecord(result);

    expect(runTurnMock).toHaveBeenCalledWith(
      'alias-input',
      undefined,
      expect.objectContaining({
        sessionId: expect.any(String),
      }),
    );
    expect(payload.success).toBe(true);
    expect(payload.response).toBe('PROMPT_OK');
  });

  it('maps runner error to module response', async () => {
    runTurnMock.mockRejectedValue(new Error('kernel failed'));
    const module = createChatCodexModule({}, runner);

    const result = await module.handle('hello');
    const payload = asRecord(result);

    expect(payload.success).toBe(false);
    expect(payload.error).toBe('kernel failed');
  });

  it('forwards metadata.inputItems into kernel user turn items', async () => {
    runTurnMock.mockResolvedValue({
      reply: 'IMAGE_OK',
      events: [],
      usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
    });
    const module = createChatCodexModule({}, runner);

    await module.handle({
      text: 'look at this',
      metadata: {
        inputItems: [
          { type: 'text', text: 'look at this' },
          { type: 'image', image_url: 'data:image/png;base64,AAAA' },
        ],
      },
    });

    expect(runTurnMock).toHaveBeenCalledWith(
      'look at this',
      [
        { type: 'text', text: 'look at this' },
        { type: 'image', image_url: 'data:image/png;base64,AAAA' },
      ],
      expect.objectContaining({
        sessionId: expect.any(String),
        systemPrompt: expect.any(String),
      }),
    );
  });

  it('maps unified input tools into structured tool specifications', async () => {
    runTurnMock.mockResolvedValue({
      reply: 'TOOLS_OK',
      events: [],
      usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
    });
    const module = createChatCodexModule({}, runner);

    await module.handle({
      text: 'run tool',
      tools: ['shell.exec'],
    });

    expect(runTurnMock).toHaveBeenCalledWith(
      'run tool',
      undefined,
      expect.objectContaining({
        tools: [
          expect.objectContaining({
            name: 'shell.exec',
          }),
        ],
      }),
    );
  });
});
