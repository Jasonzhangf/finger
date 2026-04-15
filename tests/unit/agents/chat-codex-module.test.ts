import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  __chatCodexInternals,
  type ChatCodexRunContext,
  createChatCodexModule,
  type ChatCodexRunResult,
  type ChatCodexRunner,
  type KernelInputItem,
  isRetryableRunError,
} from '../../../src/agents/chat-codex/chat-codex-module.js';
import { progressStore } from '../../../src/server/modules/progress/index.js';

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
    progressStore.clear('session-explicit-model-round-progress');
    progressStore.clear('session-stream-round-trace-progress');
    progressStore.clear('session-incomplete-round-trace-progress');
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
    const result = await module.handle(
      {
        text: 'hello',
        metadata: { stopToolMaxAutoContinueTurns: 0 },
      },
      callback,
    );
    const payload = asRecord(result);

    expect(runTurnMock).toHaveBeenCalledTimes(1);
    const callArgs = runTurnMock.mock.calls[0];
    expect(callArgs[0]).toBe('hello');
    expect(callArgs[1]).toEqual([{ type: 'text', text: 'hello' }]);
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
      [{ type: 'text', text: 'alias-input' }],
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

  it('retries timeout errors and succeeds within retry window', async () => {
    runTurnMock
      .mockRejectedValueOnce(new Error('chat-codex timed out after 600000ms'))
      .mockRejectedValueOnce(new Error('chat-codex timed out after 600000ms'))
      .mockRejectedValueOnce(new Error('chat-codex timed out after 600000ms'))
      .mockResolvedValueOnce({
        reply: 'RETRY_OK',
        events: [],
        usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
      });
    const onLoopEvent = vi.fn();
    const module = createChatCodexModule({ onLoopEvent, timeoutRetryCount: 5 }, runner);

    const result = await module.handle({
      text: 'retry timeout',
      metadata: { stopToolMaxAutoContinueTurns: 0 },
    });
    const payload = asRecord(result);

    expect(payload.success).toBe(true);
    expect(payload.response).toBe('RETRY_OK');
    expect(runTurnMock).toHaveBeenCalledTimes(4);
    const retryEvents = onLoopEvent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((event) => event.phase === 'kernel_event')
      .map((event) => asRecord(event.payload))
      .filter((payload) => payload.type === 'turn_retry');
    expect(retryEvents).toHaveLength(3);
  });

  it('stops after retry limit is exhausted', async () => {
    runTurnMock.mockRejectedValue(new Error('chat-codex timed out after 600000ms'));
    const module = createChatCodexModule({ timeoutRetryCount: 5 }, runner);

    const result = await module.handle({ text: 'retry timeout fail' });
    const payload = asRecord(result);

    expect(runTurnMock).toHaveBeenCalledTimes(6);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe('chat-codex timed out after 600000ms');
  });

  it('treats stalled kernel turns as retryable', () => {
    expect(isRetryableRunError(new Error('chat-codex stalled without kernel events for 180000ms'))).toBe(true);
  });

  it('treats active-turn supersede/epipe errors as retryable', () => {
    expect(isRetryableRunError(new Error('chat-codex active turn superseded by newer user input'))).toBe(true);
    expect(isRetryableRunError(new Error('chat-codex stale active turn evicted (idle=15232ms, age=697906ms)'))).toBe(true);
    expect(isRetryableRunError(new Error('chat-codex kernel stdin stream error: write EPIPE'))).toBe(true);
  });

  it('treats incomplete responses stream payload errors as retryable', () => {
    expect(
      isRetryableRunError(new Error('run_turn failed: responses stream did not contain a completed response payload')),
    ).toBe(true);
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

  it('keeps user text when metadata.inputItems only contains image', async () => {
    runTurnMock.mockResolvedValue({
      reply: 'IMAGE_WITH_TEXT_OK',
      events: [],
      usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
    });
    const module = createChatCodexModule({}, runner);

    await module.handle({
      text: '请描述这张图',
      metadata: {
        inputItems: [
          { type: 'local_image', path: '/tmp/demo.jpg' },
        ],
      },
    });

    expect(runTurnMock).toHaveBeenCalledWith(
      '请描述这张图',
      [
        { type: 'text', text: '请描述这张图' },
        { type: 'local_image', path: '/tmp/demo.jpg' },
      ],
      expect.objectContaining({
        sessionId: expect.any(String),
      }),
    );
  });

  it('keeps view_image tool available when turn has injected image input', async () => {
    runTurnMock.mockResolvedValue({
      reply: 'IMAGE_TOOL_FILTER_OK',
      events: [],
      usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
    });
    const module = createChatCodexModule({}, runner);

    await module.handle({
      text: '请看图',
      metadata: {
        inputItems: [
          { type: 'local_image', path: '/tmp/demo.jpg' },
        ],
      },
    });

    const tools = (runTurnMock.mock.calls[0]?.[2]?.tools ?? []).map((tool) => tool.name);
    expect(tools).toContain('view_image');
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
      tools: ['exec_command'],
    });

    expect(runTurnMock).toHaveBeenCalledWith(
      'run tool',
      [{ type: 'text', text: 'run tool' }],
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({
            name: 'exec_command',
          }),
        ]),
      }),
    );
  });

  it('injects compatibility aliases for tool names (snake/camel/flat)', async () => {
    runTurnMock.mockResolvedValue({
      reply: 'ALIASES_OK',
      events: [],
      usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
    });
    const module = createChatCodexModule({}, runner);

    await module.handle({
      text: 'check tool aliases',
      metadata: { roleProfile: 'system' },
    });

    const tools = (runTurnMock.mock.calls[0]?.[2]?.tools ?? []).map((tool) => tool.name);
    expect(tools).toContain('agent.list');
    expect(tools).toContain('agent_list');
    expect(tools).toContain('agentList');
    expect(tools).toContain('agentlist');
    expect(tools).toContain('command.exec');
    expect(tools).toContain('command_exec');
    expect(tools).toContain('reasoning.stop');
    expect(tools).toContain('reasoning_stop');
    expect(tools).toContain('reasoningStop');
  });

  it('emits synthetic tool events and keeps task_complete tool trace payload', async () => {
    const onLoopEvent = vi.fn();
    runTurnMock.mockResolvedValue({
      reply: 'DONE',
      events: [
        {
          id: 'turn-1',
          msg: {
            type: 'task_complete',
            last_agent_message: 'DONE',
            metadata_json: JSON.stringify({
              tool_trace: [
                {
                  call_id: 'call_1',
                  tool: 'shell.exec',
                  status: 'ok',
                  input: { cmd: 'pwd' },
                  output: { stdout: '/tmp' },
                  duration_ms: 12,
                },
              ],
            }),
          },
        },
      ],
      usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
    });

    const module = createChatCodexModule({ onLoopEvent }, runner);
    await module.handle({ text: 'hello' });

    const kernelEvents = onLoopEvent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((event) => event.phase === 'kernel_event');
    const eventTypes = kernelEvents
      .map((event) => asRecord(event.payload).type)
      .filter((type): type is string => typeof type === 'string');
    expect(eventTypes).toContain('tool_call');
    expect(eventTypes).toContain('tool_result');
    expect(eventTypes).toContain('task_complete');

    const taskComplete = kernelEvents.find((event) => asRecord(event.payload).type === 'task_complete');
    expect(taskComplete).toBeDefined();
    const payload = asRecord(taskComplete?.payload);
    expect(payload.syntheticToolEvents).toBe(true);
    expect(payload.toolTrace).toEqual([
      {
        callId: 'call_1',
        tool: 'shell.exec',
        status: 'ok',
        input: { cmd: 'pwd' },
        output: { stdout: '/tmp' },
        durationMs: 12,
      },
    ]);
  });

  it('passes through realtime kernel tool events from rust protocol', async () => {
    const onLoopEvent = vi.fn();
    runTurnMock.mockResolvedValue({
      reply: 'DONE',
      events: [
        {
          id: 'turn-2',
          msg: {
            type: 'tool_call',
            seq: 1,
            call_id: 'call_rt_1',
            tool_name: 'exec_command',
            input: { cmd: 'pwd' },
          },
        },
        {
          id: 'turn-2',
          msg: {
            type: 'tool_result',
            seq: 2,
            call_id: 'call_rt_1',
            tool_name: 'exec_command',
            output: { ok: true },
            duration_ms: 18,
          },
        },
        {
          id: 'turn-2',
          msg: {
            type: 'task_complete',
            last_agent_message: 'DONE',
          },
        },
      ],
      usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
    });

    const module = createChatCodexModule({ onLoopEvent }, runner);
    await module.handle({ text: 'hello' });

    const kernelEvents = onLoopEvent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((event) => event.phase === 'kernel_event');
    const toolCallPayload = kernelEvents
      .map((event) => asRecord(event.payload))
      .find((payload) => payload.type === 'tool_call');
    const toolResultPayload = kernelEvents
      .map((event) => asRecord(event.payload))
      .find((payload) => payload.type === 'tool_result');

    expect(toolCallPayload).toMatchObject({
      type: 'tool_call',
      seq: 1,
      toolName: 'exec_command',
      toolId: 'call_rt_1',
      input: { cmd: 'pwd' },
    });
    expect(toolResultPayload).toMatchObject({
      type: 'tool_result',
      seq: 2,
      toolName: 'exec_command',
      toolId: 'call_rt_1',
      duration: 18,
      output: { ok: true },
    });
  });

  it('marks task_complete with realtimeToolEvents when streamed tool events already emitted', async () => {
    const onLoopEvent = vi.fn();
    const streamingRunner: ChatCodexRunner = {
      runTurn: async (_text, _items, context) => {
        context?.onKernelEvent?.({
          id: 'turn-stream',
          msg: {
            type: 'tool_call',
            seq: 1,
            call_id: 'call_stream_1',
            tool_name: 'exec_command',
            input: { cmd: 'pwd' },
          },
        });
        context?.onKernelEvent?.({
          id: 'turn-stream',
          msg: {
            type: 'tool_result',
            seq: 2,
            call_id: 'call_stream_1',
            tool_name: 'exec_command',
            output: { ok: true, result: { stdout: '/tmp' } },
            duration_ms: 7,
          },
        });
        const taskCompleteEvent = {
          id: 'turn-stream',
          msg: {
            type: 'task_complete',
            last_agent_message: 'DONE',
            metadata_json: JSON.stringify({
              tool_trace: [
                {
                  call_id: 'call_stream_1',
                  tool: 'exec_command',
                  status: 'ok',
                  input: { cmd: 'pwd' },
                  output: { ok: true, result: { stdout: '/tmp' } },
                  duration_ms: 7,
                },
              ],
            }),
          },
        } as const;
        context?.onKernelEvent?.(taskCompleteEvent);
        return {
          reply: 'DONE',
          events: [taskCompleteEvent],
          usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
        };
      },
    };

    const module = createChatCodexModule({ onLoopEvent }, streamingRunner);
    await module.handle({
      text: 'stream test',
      metadata: { stopToolMaxAutoContinueTurns: 0 },
    });

    const kernelPayloads = onLoopEvent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((event) => event.phase === 'kernel_event')
      .map((event) => asRecord(event.payload));

    expect(kernelPayloads.filter((payload) => payload.type === 'tool_call')).toHaveLength(1);
    expect(kernelPayloads.filter((payload) => payload.type === 'tool_result')).toHaveLength(1);
    const taskCompletePayload = kernelPayloads.find((payload) => payload.type === 'task_complete');
    expect(taskCompletePayload).toBeDefined();
    expect(taskCompletePayload?.realtimeToolEvents).toBe(true);
  });

  it('emits reasoning immediately from model_round metadata and deduplicates repeated task_complete reasoning', async () => {
    const onLoopEvent = vi.fn();
    const streamingRunner: ChatCodexRunner = {
      runTurn: async (_text, _items, context) => {
        const metadataJson = JSON.stringify({
          reasoning_trace: ['先检查日志再决定下一步'],
        });
        context?.onKernelEvent?.({
          id: 'turn-reasoning-stream',
          msg: {
            type: 'model_round',
            seq: 1,
            round: 1,
            reasoning_count: 1,
            metadata_json: metadataJson,
          },
        });
        const taskCompleteEvent = {
          id: 'turn-reasoning-stream',
          msg: {
            type: 'task_complete',
            last_agent_message: 'DONE',
            metadata_json: metadataJson,
          },
        } as const;
        context?.onKernelEvent?.(taskCompleteEvent);
        return {
          reply: 'DONE',
          events: [taskCompleteEvent],
          usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
        };
      },
    };

    const module = createChatCodexModule({ onLoopEvent }, streamingRunner);
    await module.handle({
      text: 'stream reasoning test',
      metadata: { stopToolMaxAutoContinueTurns: 0 },
    });

    const events = onLoopEvent.mock.calls.map((call) => call[0] as Record<string, unknown>);
    const reasoningEvents = events.filter((event) => {
      if (event.phase !== 'kernel_event') return false;
      const payload = asRecord(event.payload);
      return payload.type === 'reasoning';
    });

    expect(reasoningEvents).toHaveLength(1);
    expect(asRecord(reasoningEvents[0].payload).text).toBe('先检查日志再决定下一步');

    const reasoningIndex = events.findIndex((event) => {
      if (event.phase !== 'kernel_event') return false;
      const payload = asRecord(event.payload);
      return payload.type === 'reasoning';
    });
    const turnCompleteIndex = events.findIndex((event) => event.phase === 'turn_complete');
    expect(reasoningIndex).toBeGreaterThanOrEqual(0);
    expect(turnCompleteIndex).toBeGreaterThan(reasoningIndex);
  });

  it('emits realtime reasoning kernel events immediately (without waiting for metadata trace)', async () => {
    const onLoopEvent = vi.fn();
    const streamingRunner: ChatCodexRunner = {
      runTurn: async (_text, _items, context) => {
        context?.onKernelEvent?.({
          id: 'turn-reasoning-direct',
          msg: {
            type: 'reasoning',
            seq: 1,
            message: '先读取配置再继续执行',
          },
        });
        const taskCompleteEvent = {
          id: 'turn-reasoning-direct',
          msg: {
            type: 'task_complete',
            last_agent_message: 'DONE',
          },
        } as const;
        context?.onKernelEvent?.(taskCompleteEvent);
        return {
          reply: 'DONE',
          events: [taskCompleteEvent],
          usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
        };
      },
    };

    const module = createChatCodexModule({ onLoopEvent }, streamingRunner);
    await module.handle({
      text: 'stream realtime reasoning test',
      metadata: { stopToolMaxAutoContinueTurns: 0 },
    });

    const events = onLoopEvent.mock.calls.map((call) => call[0] as Record<string, unknown>);
    const reasoningEvents = events.filter((event) => {
      if (event.phase !== 'kernel_event') return false;
      const payload = asRecord(event.payload);
      return payload.type === 'reasoning';
    });

    expect(reasoningEvents).toHaveLength(1);
    const reasoningPayload = asRecord(reasoningEvents[0].payload);
    expect(reasoningPayload.text).toBe('先读取配置再继续执行');
    expect(reasoningPayload.agentId).toBeDefined();
    expect(reasoningPayload.roleProfile).toBeDefined();

    const reasoningIndex = events.findIndex((event) => {
      if (event.phase !== 'kernel_event') return false;
      const payload = asRecord(event.payload);
      return payload.type === 'reasoning';
    });
    const turnCompleteIndex = events.findIndex((event) => event.phase === 'turn_complete');
    expect(reasoningIndex).toBeGreaterThanOrEqual(0);
    expect(turnCompleteIndex).toBeGreaterThan(reasoningIndex);
  });

  it('updates progressStore as soon as explicit model_round arrives', async () => {
    const sessionId = 'session-explicit-model-round-progress';
    const streamingRunner: ChatCodexRunner = {
      runTurn: async (_text, _items, context) => {
        context?.onKernelEvent?.({
          id: 'turn-explicit-round',
          msg: {
            type: 'model_round',
            seq: 1,
            round: 1,
            history_items_count: 12,
            input_tokens: 3200,
            output_tokens: 180,
            total_tokens: 3380,
            estimated_tokens_in_context_window: 118000,
            context_usage_percent: 45,
            max_input_tokens: 262144,
          },
        });
        const taskCompleteEvent = {
          id: 'turn-explicit-round',
          msg: {
            type: 'task_complete',
            last_agent_message: 'DONE',
          },
        } as const;
        context?.onKernelEvent?.(taskCompleteEvent);
        return {
          reply: 'DONE',
          events: [taskCompleteEvent],
          usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
        };
      },
    };

    const module = createChatCodexModule({}, streamingRunner);
    await module.handle({
      text: 'stream explicit round test',
      sessionId,
      roleProfile: 'system',
      metadata: {
        stopToolMaxAutoContinueTurns: 0,
        contextLedgerAgentId: 'finger-system-agent',
        contextLedgerRole: 'system',
      },
    });

    const snapshot = progressStore.get(sessionId, 'finger-system-agent');
    expect(snapshot?.latestKernelMetadata).toMatchObject({
      round: 1,
      seq: 1,
      history_items_count: 12,
      input_tokens: 3200,
      output_tokens: 180,
      total_tokens: 3380,
      context_window: 262144,
      context_usage_percent: 45,
    });
  });

  it('emits synthetic model_round from tool_result metadata before turn_complete and updates progressStore', async () => {
    const sessionId = 'session-stream-round-trace-progress';
    const onLoopEvent = vi.fn();
    const metadataJson = JSON.stringify({
      round_trace: [
        {
          seq: 3,
          round: 1,
          history_items_count: 9,
          input_tokens: 2048,
          output_tokens: 96,
          total_tokens: 2144,
          estimated_tokens_in_context_window: 120000,
          context_usage_percent: 46,
          max_input_tokens: 262144,
          response_id: 'resp_round_trace_1',
        },
      ],
    });
    const streamingRunner: ChatCodexRunner = {
      runTurn: async (_text, _items, context) => {
        context?.onKernelEvent?.({
          id: 'turn-round-trace',
          msg: {
            type: 'tool_call',
            seq: 1,
            call_id: 'call_rt_ctx',
            tool_name: 'exec_command',
            input: { cmd: 'ls' },
          },
        });
        context?.onKernelEvent?.({
          id: 'turn-round-trace',
          msg: {
            type: 'tool_result',
            seq: 2,
            call_id: 'call_rt_ctx',
            tool_name: 'exec_command',
            output: { ok: true },
            duration_ms: 8,
            metadata_json: metadataJson,
          },
        });
        const taskCompleteEvent = {
          id: 'turn-round-trace',
          msg: {
            type: 'task_complete',
            last_agent_message: 'DONE',
            metadata_json: metadataJson,
          },
        } as const;
        context?.onKernelEvent?.(taskCompleteEvent);
        return {
          reply: 'DONE',
          events: [taskCompleteEvent],
          usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
        };
      },
    };

    const module = createChatCodexModule({ onLoopEvent }, streamingRunner);
    await module.handle({
      text: 'stream round trace test',
      sessionId,
      roleProfile: 'system',
      metadata: {
        stopToolMaxAutoContinueTurns: 0,
        contextLedgerAgentId: 'finger-system-agent',
        contextLedgerRole: 'system',
      },
    });

    const events = onLoopEvent.mock.calls.map((call) => call[0] as Record<string, unknown>);
    const kernelPayloads = events
      .filter((event) => event.phase === 'kernel_event')
      .map((event) => asRecord(event.payload));
    expect(kernelPayloads.filter((payload) => payload.type === 'model_round')).toHaveLength(1);

    const toolResultIndex = events.findIndex((event) => {
      if (event.phase !== 'kernel_event') return false;
      const payload = asRecord(event.payload);
      return payload.type === 'tool_result';
    });
    const modelRoundIndex = events.findIndex((event) => {
      if (event.phase !== 'kernel_event') return false;
      const payload = asRecord(event.payload);
      return payload.type === 'model_round';
    });
    const turnCompleteIndex = events.findIndex((event) => event.phase === 'turn_complete');
    expect(toolResultIndex).toBeGreaterThanOrEqual(0);
    expect(modelRoundIndex).toBeGreaterThan(toolResultIndex);
    expect(turnCompleteIndex).toBeGreaterThan(modelRoundIndex);

    const snapshot = progressStore.get(sessionId, 'finger-system-agent');
    expect(snapshot?.latestKernelMetadata).toMatchObject({
      round: 1,
      seq: 3,
      history_items_count: 9,
      input_tokens: 2048,
      output_tokens: 96,
      total_tokens: 2144,
      estimated_tokens_in_context_window: 120000,
      context_window: 262144,
      context_usage_percent: 46,
    });
  });

  it('keeps last-known-good context stats when later round_trace omits token fields', async () => {
    const sessionId = 'session-incomplete-round-trace-progress';
    const metadataJson = JSON.stringify({
      round_trace: [
        {
          seq: 2,
          round: 2,
          max_input_tokens: 262144,
        },
      ],
    });
    const streamingRunner: ChatCodexRunner = {
      runTurn: async (_text, _items, context) => {
        context?.onKernelEvent?.({
          id: 'turn-incomplete-round-trace',
          msg: {
            type: 'model_round',
            seq: 1,
            round: 1,
            history_items_count: 12,
            input_tokens: 3200,
            output_tokens: 180,
            total_tokens: 3380,
            estimated_tokens_in_context_window: 118000,
            context_usage_percent: 45,
            max_input_tokens: 262144,
          },
        });
        context?.onKernelEvent?.({
          id: 'turn-incomplete-round-trace',
          msg: {
            type: 'tool_result',
            seq: 2,
            call_id: 'call_incomplete_round_trace',
            tool_name: 'exec_command',
            output: { ok: true },
            duration_ms: 8,
            metadata_json: metadataJson,
          },
        });
        const taskCompleteEvent = {
          id: 'turn-incomplete-round-trace',
          msg: {
            type: 'task_complete',
            last_agent_message: 'DONE',
            metadata_json: metadataJson,
          },
        } as const;
        context?.onKernelEvent?.(taskCompleteEvent);
        return {
          reply: 'DONE',
          events: [taskCompleteEvent],
          usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
        };
      },
    };

    const module = createChatCodexModule({}, streamingRunner);
    await module.handle({
      text: 'incomplete round trace test',
      sessionId,
      roleProfile: 'system',
      metadata: {
        stopToolMaxAutoContinueTurns: 0,
        contextLedgerAgentId: 'finger-system-agent',
        contextLedgerRole: 'system',
      },
    });

    const snapshot = progressStore.get(sessionId, 'finger-system-agent');
    expect(snapshot?.latestKernelMetadata).toMatchObject({
      round: 2,
      seq: 2,
      input_tokens: 3200,
      output_tokens: 180,
      total_tokens: 3380,
      estimated_tokens_in_context_window: 118000,
      context_window: 262144,
      context_usage_percent: 45,
    });
    expect(snapshot?.latestKernelMetadata?.input_tokens).not.toBe(0);
    expect(snapshot?.latestKernelMetadata?.total_tokens).not.toBe(0);
  });

  it('marks turn_complete as pending-input acknowledgement when active turn already exists', async () => {
    const onLoopEvent = vi.fn();
    const queuedRunner: ChatCodexRunner = {
      runTurn: async () => ({
        reply: '已加入当前执行队列，等待本轮合并处理。',
        events: [
          {
            id: 'pending-1',
            msg: {
              type: 'pending_input_queued',
              message: 'pending input queued to active turn',
            },
          },
        ],
        usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
        kernelMetadata: {
          pendingInputAccepted: true,
          activeTurnId: 'active-1',
          pendingTurnId: 'pending-1',
        },
      }),
    };

    const module = createChatCodexModule({ onLoopEvent }, queuedRunner);
    await module.handle({ text: '继续处理' });

    const turnComplete = onLoopEvent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((event) => event.phase === 'turn_complete');
    expect(turnComplete).toBeDefined();
    expect(asRecord(turnComplete?.payload).pendingInputAccepted).toBe(true);
    expect(asRecord(turnComplete?.payload).pendingTurnId).toBe('pending-1');
    expect(asRecord(turnComplete?.payload).activeTurnId).toBe('active-1');
  });

  it('forwards stop/control gate metadata to turn_complete payload for deadlock-safe finalization', async () => {
    const onLoopEvent = vi.fn();
    const gateRunner: ChatCodexRunner = {
      runTurn: async () => ({
        reply: 'DONE',
        events: [
          {
            id: 'gate-1',
            msg: {
              type: 'task_complete',
              last_agent_message: 'DONE',
            },
          },
        ],
        usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
        kernelMetadata: {
          stopToolGateApplied: true,
          stopToolGateAttempt: 2,
          stopToolMaxAutoContinueTurns: 2,
          controlBlockGateApplied: true,
          controlBlockGateAttempt: 2,
          controlBlockMaxAutoContinueTurns: 2,
        },
      }),
    };
    const module = createChatCodexModule({ onLoopEvent }, gateRunner);

    await module.handle({
      text: 'gate metadata forwarding',
      metadata: { stopToolMaxAutoContinueTurns: 2 },
    });

    const turnComplete = onLoopEvent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((event) => event.phase === 'turn_complete');
    expect(turnComplete).toBeDefined();
    const payload = asRecord(turnComplete?.payload);
    expect(payload.stopToolGateApplied).toBe(true);
    expect(payload.stopToolGateAttempt).toBe(2);
    expect(payload.stopToolMaxAutoContinueTurns).toBe(2);
    expect(payload.controlBlockGateApplied).toBe(true);
    expect(payload.controlBlockGateAttempt).toBe(2);
    expect(payload.controlBlockMaxAutoContinueTurns).toBe(2);
  });

  it('keeps system prompt stable across system and project roles', async () => {
    runTurnMock.mockResolvedValue({
      reply: 'OK',
      events: [],
      usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
    });
    const module = createChatCodexModule({}, runner);

    await module.handle({
      text: 'system task',
      roleProfile: 'system',
      metadata: { stopToolMaxAutoContinueTurns: 0 },
    });
    await module.handle({
      text: 'project task',
      roleProfile: 'project',
      metadata: { stopToolMaxAutoContinueTurns: 0 },
    });

    expect(runTurnMock).toHaveBeenCalledTimes(2);
    const firstPrompt = runTurnMock.mock.calls[0][2]?.systemPrompt;
    const secondPrompt = runTurnMock.mock.calls[1][2]?.systemPrompt;
    expect(typeof firstPrompt).toBe('string');
    expect(firstPrompt).toBe(secondPrompt);
  });

  it('builds role-specific developer instructions with ledger block in developer zone', () => {
    const system = __chatCodexInternals.buildKernelUserTurnOptions(
      {
        sessionId: 'session-1',
        metadata: {
          roleProfile: 'system',
          contextLedgerEnabled: true,
          contextLedgerAgentId: 'chat-codex',
          contextLedgerRole: 'system',
          kernelMode: 'main',
        },
      },
      undefined,
    );
    const project = __chatCodexInternals.buildKernelUserTurnOptions(
      {
        sessionId: 'session-1',
        metadata: {
          roleProfile: 'project',
          contextLedgerEnabled: true,
          contextLedgerAgentId: 'chat-codex',
          contextLedgerRole: 'project',
          kernelMode: 'main',
        },
      },
      undefined,
    );

    expect(system?.developer_instructions).toContain('role=system');
    expect(system?.developer_instructions).toContain('[context_ledger]');
    expect(project?.developer_instructions).toContain('role=project');
    expect(project?.developer_instructions).toContain('[context_ledger]');
    expect(system?.developer_instructions).not.toBe(project?.developer_instructions);
  });

  it('maps project-like roles onto project developer instructions', () => {
    const executor = __chatCodexInternals.resolveDeveloperInstructions({
      roleProfile: 'executor',
      contextLedgerEnabled: true,
      kernelMode: 'main',
    });
    const searcher = __chatCodexInternals.resolveDeveloperInstructions({
      roleProfile: 'searcher',
      contextLedgerEnabled: true,
      kernelMode: 'main',
    });

    expect(executor).toContain('role=project');
    expect(searcher).toContain('role=project');
    expect(executor).toContain('[context_ledger]');
    expect(searcher).toContain('[context_ledger]');
    expect(executor).toBe(searcher);
  });

  it('injects prompt optimization runtime section with agent contract and output style', () => {
    const instructions = __chatCodexInternals.resolveDeveloperInstructions({
      roleProfile: 'project',
      promptOptimizationEnabled: true,
      promptOptAgentDefinitionEnabled: true,
      promptOptFunctionResultClearingEnabled: true,
      promptOptOutputStyleEnabled: true,
      outputStyle: 'technical',
      contextLedgerEnabled: true,
      kernelMode: 'main',
    });

    expect(instructions).toContain('# Prompt Optimization Runtime');
    expect(instructions).toContain('agent_type=project');
    expect(instructions).toContain('Function Result Clearing');
    expect(instructions).toContain('Output Style: Technical');
  });

  it('can disable prompt optimization runtime section', () => {
    const instructions = __chatCodexInternals.resolveDeveloperInstructions({
      roleProfile: 'project',
      promptOptimizationEnabled: false,
      contextLedgerEnabled: true,
      kernelMode: 'main',
    });

    expect(instructions).not.toContain('# Prompt Optimization Runtime');
  });

  it('teaches ledger retrieval model inside developer instructions', () => {
    const instructions = __chatCodexInternals.buildLedgerDeveloperInstructions(
      {
        contextLedgerEnabled: true,
        contextLedgerAgentId: 'finger-system-agent',
        contextLedgerRole: 'orchestrator',
        kernelMode: 'main',
        workingSetTaskBlockCount: 1,
        historicalTaskBlockCount: 2,
        workingSetMessageCount: 3,
        historicalMessageCount: 8,
        workingSetTokens: 500,
        historicalTokens: 1500,
      },
      'orchestrator',
    );

    expect(instructions).toContain('[context_ledger]');
    expect(instructions).toContain('enabled=true');
    expect(instructions).toContain('agent_id=finger-system-agent');
    expect(instructions).toContain('role=orchestrator');
    expect(instructions).toContain('working_set_task_blocks=1');
    expect(instructions).toContain('historical_task_blocks=2');
    expect(instructions).toContain('working_set_tokens=500');
    expect(instructions).toContain('historical_tokens=1500');
  });

  it('exposes current prompt optimization runtime for context-history turns', () => {
    const options = __chatCodexInternals.buildKernelUserTurnOptions(
      {
        sessionId: 'session-1',
        history: [
          { role: 'user', content: '先检查邮件去重脚本是否还在重复发送。' },
          { role: 'assistant', content: '我先看邮件去重逻辑和最近日志。' },
          { role: 'user', content: '然后顺便看下新闻推送格式。' },
          { role: 'assistant', content: '我会一起核查新闻推送模板。' },
          { role: 'user', content: '继续处理，不要中断。' },
        ],
        metadata: {
          roleProfile: 'system',
          kernelMode: 'main',
          contextLedgerEnabled: true,
          contextHistorySource: 'context_history_single_source',
        },
      },
      undefined,
    );

    const instructions = options?.developer_instructions ?? '';
    expect(instructions).toContain('# Prompt Optimization Runtime');
    expect(instructions).toContain('role=system');
  });

  it('grants project agent full tool access', async () => {
    runTurnMock.mockResolvedValue({
      reply: 'OK',
      events: [],
      usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
    });
    const module = createChatCodexModule({}, runner);

    await module.handle({
      text: 'develop task',
      roleProfile: 'project',
      metadata: { stopToolMaxAutoContinueTurns: 0 },
    });

    const tools = (runTurnMock.mock.calls[0][2]?.tools ?? []).map((item) => item.name);
    expect(tools).toContain('patch');
  });

  it('keeps structured output schema disabled by default', () => {
    const options = __chatCodexInternals.buildKernelUserTurnOptions(
      {
        sessionId: 'session-1',
        metadata: {
          roleProfile: 'system',
          kernelMode: 'main',
        },
      },
      undefined,
    );

    expect(options?.responses?.text?.output_schema).toBeUndefined();
  });

  it('enables role default structured output schema when requested', () => {
    const options = __chatCodexInternals.buildKernelUserTurnOptions(
      {
        sessionId: 'session-1',
        metadata: {
          roleProfile: 'project',
          kernelMode: 'main',
          responsesStructuredOutput: true,
        },
      },
      undefined,
    );

    const schema = options?.responses?.text?.output_schema as Record<string, unknown> | undefined;
    expect(schema).toBeDefined();
    expect(schema?.type).toBe('object');
    expect(schema?.properties).toMatchObject({
      role: { type: 'string', const: 'project' },
      summary: { type: 'string' },
      status: { type: 'string', enum: ['completed', 'failed', 'retry'] },
      evidence: { type: 'string' },
      nextAction: { type: 'string' },
    });
  });

  it('prefers explicit responsesOutputSchema over role defaults', () => {
    const explicitSchema = {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
      },
      required: ['ok'],
      additionalProperties: false,
    };
    const options = __chatCodexInternals.buildKernelUserTurnOptions(
      {
        sessionId: 'session-1',
        metadata: {
          roleProfile: 'executor',
          kernelMode: 'main',
          responsesStructuredOutput: true,
          responsesOutputSchema: explicitSchema,
        },
      },
      undefined,
    );

    expect(options?.responses?.text?.output_schema).toEqual(explicitSchema);
  });

  it('loads Global+Local FLOW paths and full content into system prompt', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'finger-flow-test-'));
    const globalFlowPath = join(tempDir, 'FLOW.global.md');
    const localFlowPath = join(tempDir, 'FLOW.local.md');
    const globalContent = `GLOBAL\n${'G'.repeat(10_050)}\nGLOBAL_END`;
    const localContent = `LOCAL\n${'L'.repeat(10_050)}\nLOCAL_END`;
    writeFileSync(globalFlowPath, globalContent, 'utf-8');
    writeFileSync(localFlowPath, localContent, 'utf-8');

    try {
      const options = __chatCodexInternals.buildKernelUserTurnOptions(
        {
          sessionId: 'session-1',
          metadata: {
            roleProfile: 'system',
            kernelMode: 'main',
            skillsPromptEnabled: false,
            mailboxPromptEnabled: false,
            globalFlowFilePath: globalFlowPath,
            flowFilePath: localFlowPath,
          },
        },
        undefined,
      );

      const instructions = options?.developer_instructions ?? '';
      expect(instructions).toContain(`FLOW.global.path=${globalFlowPath}`);
      expect(instructions).toContain(`FLOW.local.path=${localFlowPath}`);
      const globalHeaderIndex = instructions.indexOf('FLOW.content.global:');
      const localHeaderIndex = instructions.indexOf('FLOW.content.local:');
      expect(globalHeaderIndex).toBeGreaterThanOrEqual(0);
      expect(localHeaderIndex).toBeGreaterThan(globalHeaderIndex);

      const fencedBlocks = Array.from(instructions.matchAll(/```md\n([\s\S]*?)```/g)).map((match) => match[1] ?? '');
      expect(fencedBlocks.length).toBe(2);
      expect(fencedBlocks[0]?.startsWith('GLOBAL')).toBe(true);
      expect(fencedBlocks[1]?.startsWith('LOCAL')).toBe(true);
      expect(fencedBlocks[0]).toContain('GLOBAL_END');
      expect(fencedBlocks[1]).toContain('LOCAL_END');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not inject FLOW block when flow prompt is disabled', () => {
    const options = __chatCodexInternals.buildKernelUserTurnOptions(
      {
        sessionId: 'session-1',
        metadata: {
          roleProfile: 'system',
          kernelMode: 'main',
          flowPromptEnabled: false,
          skillsPromptEnabled: false,
          mailboxPromptEnabled: false,
        },
      },
      undefined,
    );

    expect(options?.developer_instructions ?? '').not.toContain('FLOW.global.path=');
    expect(options?.developer_instructions ?? '').not.toContain('FLOW.local.path=');
  });

  it('injects project-scoped AGENTS runtime block with directory precedence', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'finger-agents-scope-'));
    const projectRoot = join(tempDir, 'project-a');
    const nestedDir = join(projectRoot, 'src', 'feature');
    mkdirSync(nestedDir, { recursive: true });
    const rootAgentsPath = join(projectRoot, 'AGENTS.md');
    const nestedAgentsPath = join(projectRoot, 'src', 'AGENTS.md');
    writeFileSync(rootAgentsPath, '# ROOT AGENTS\n- root rule', 'utf-8');
    writeFileSync(nestedAgentsPath, '# NESTED AGENTS\n- nested rule', 'utf-8');

    try {
      const options = __chatCodexInternals.buildKernelUserTurnOptions(
        {
          sessionId: 'session-1',
          metadata: {
            roleProfile: 'project',
            kernelMode: 'main',
            skillsPromptEnabled: false,
            mailboxPromptEnabled: false,
            userProfilePromptEnabled: false,
            memoryRoutingPromptEnabled: false,
            flowPromptEnabled: false,
            projectPath: projectRoot,
            cwd: nestedDir,
          },
        },
        undefined,
      );

      const instructions = options?.developer_instructions ?? '';
      expect(instructions).toContain(`AGENTS.project_root=${projectRoot}`);
      expect(instructions).toContain(rootAgentsPath);
      expect(instructions).toContain(nestedAgentsPath);
      expect(instructions.indexOf(rootAgentsPath)).toBeLessThan(instructions.indexOf(nestedAgentsPath));
      expect(instructions).toContain('ROOT AGENTS');
      expect(instructions).toContain('NESTED AGENTS');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads project-local skills for project-agent context', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'finger-project-skills-'));
    const projectRoot = join(tempDir, 'project-b');
    const projectSkillsRoot = join(projectRoot, '.codex', 'skills', 'project-debug-skill');
    mkdirSync(projectSkillsRoot, { recursive: true });
    writeFileSync(
      join(projectSkillsRoot, 'SKILL.md'),
      [
        '---',
        'name: project-debug-skill',
        'description: Project local debug workflow',
        '---',
        '',
        '# project-debug-skill',
      ].join('\n'),
      'utf-8',
    );

    try {
      const options = __chatCodexInternals.buildKernelUserTurnOptions(
        {
          sessionId: 'session-1',
          metadata: {
            roleProfile: 'project',
            kernelMode: 'main',
            mailboxPromptEnabled: false,
            userProfilePromptEnabled: false,
            memoryRoutingPromptEnabled: false,
            flowPromptEnabled: false,
            projectPath: projectRoot,
            cwd: projectRoot,
          },
        },
        undefined,
      );

      const instructions = options?.developer_instructions ?? '';
      expect(instructions).toContain('project-debug-skill: Project local debug workflow');
      expect(instructions).toContain(`${projectRoot}/.codex/skills/project-debug-skill/SKILL.md`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps skills/mailbox/flow prompt blocks stable across raw and rebuilt history sources', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'finger-flow-stability-'));
    const globalFlowPath = join(tempDir, 'global-flow.md');
    const localFlowPath = join(tempDir, 'local-flow.md');
    writeFileSync(globalFlowPath, 'GLOBAL_FLOW_STABILITY_MARKER', 'utf-8');
    writeFileSync(localFlowPath, 'LOCAL_FLOW_STABILITY_MARKER', 'utf-8');

    try {
      const baseContext = {
        sessionId: 'session-1',
        metadata: {
          roleProfile: 'system',
          kernelMode: 'main',
          globalFlowFilePath: globalFlowPath,
          flowFilePath: localFlowPath,
          mailboxPromptEnabled: true,
          skillsPromptEnabled: true,
        },
        mailboxSnapshot: {
          currentSeq: 12,
          hasUnread: false,
          entries: [],
        },
      } as const;

      const rawOptions = __chatCodexInternals.buildKernelUserTurnOptions(
        {
          ...baseContext,
          history: [
            { role: 'user', content: 'raw source task' },
            { role: 'assistant', content: 'raw source reply' },
          ],
          metadata: {
            ...baseContext.metadata,
            contextHistorySource: 'raw_session',
            contextHistoryBypassed: true,
          },
        },
        undefined,
      );

      const rebuiltOptions = __chatCodexInternals.buildKernelUserTurnOptions(
        {
          ...baseContext,
          history: [
            { role: 'user', content: 'rebuilt source task' },
            { role: 'assistant', content: 'rebuilt source reply' },
          ],
          metadata: {
            ...baseContext.metadata,
            contextHistorySource: 'context_history_single_source',
            contextHistoryRebuilt: true,
          },
        },
        undefined,
      );

      const rawInstructions = rawOptions?.developer_instructions ?? '';
      const rebuiltInstructions = rebuiltOptions?.developer_instructions ?? '';

      const requiredMarkers = [
        `FLOW.global.path=${globalFlowPath}`,
        `FLOW.local.path=${localFlowPath}`,
        'GLOBAL_FLOW_STABILITY_MARKER',
        'LOCAL_FLOW_STABILITY_MARKER',
        'MAILBOX.currentSeq=12',
        'MAILBOX.unread=0',
      ];
      for (const marker of requiredMarkers) {
        expect(rawInstructions).toContain(marker);
        expect(rebuiltInstructions).toContain(marker);
      }

      expect(rawInstructions.includes('FLOW.content.global:')).toBe(rebuiltInstructions.includes('FLOW.content.global:'));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to metadata kernelApiHistory when context-builder history is preferred but runtime history is empty', () => {
    const metadataHistory = [
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'previous user context' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'previous assistant context' }],
      },
    ];
    const options = __chatCodexInternals.buildKernelUserTurnOptions(
      {
        sessionId: 'session-1',
        history: [],
        metadata: {
          roleProfile: 'system',
          role: 'user',
          source: 'channel',
          kernelMode: 'main',
          contextHistorySource: 'context_history_single_source',
          contextHistoryRebuilt: false,
          kernelApiHistory: metadataHistory,
        },
      },
      undefined,
    );

    expect(options?.history_items).toEqual(metadataHistory);
  });

  it('prefers runtime raw_session history over metadata kernelApiHistory when both exist', () => {
    const metadataHistory = [
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'metadata history user' }],
      },
    ];
    const options = __chatCodexInternals.buildKernelUserTurnOptions(
      {
        sessionId: 'session-1',
        history: [
          { role: 'user', content: 'runtime user history' },
          { role: 'assistant', content: 'runtime assistant history' },
        ],
        metadata: {
          roleProfile: 'system',
          role: 'user',
          source: 'channel',
          kernelMode: 'main',
          contextHistorySource: 'raw_session',
          contextHistoryBypassed: true,
          contextHistoryBypassReason: 'single_source_runtime_snapshot',
          kernelApiHistory: metadataHistory,
        },
      },
      undefined,
    );

    expect(Array.isArray(options?.history_items)).toBe(true);
    const historyItems = options?.history_items ?? [];
    expect(historyItems.length).toBe(2);
    expect(JSON.stringify(historyItems)).toContain('runtime user history');
    expect(JSON.stringify(historyItems)).not.toContain('metadata history user');
  });

  it('maps preflight compact metadata into kernel compact.manual options', () => {
    const options = __chatCodexInternals.buildKernelUserTurnOptions(
      {
        sessionId: 'session-preflight-compact',
        history: [
          { role: 'user', content: 'legacy raw history' },
          { role: 'assistant', content: 'legacy raw reply' },
        ],
        metadata: {
          roleProfile: 'system',
          role: 'user',
          source: 'channel',
          kernelMode: 'main',
          compactManual: true,
          preflightCompact: {
            trigger: 'session_projection_threshold',
            sessionTokens: 300_000,
            projectedTokens: 300_010,
          },
        },
      },
      undefined,
    );

    expect(options?.compact).toEqual(
      expect.objectContaining({
        manual: true,
      }),
    );
  });

});

describe('isRetryableRunError', () => {
  it('should identify "error code: 502" as retryable', () => {
    const error = new Error('responses api returned non-success status: 502; body: error code: 502');
    expect(isRetryableRunError(error)).toBe(true);
  });

  it('should identify "http 502" as retryable', () => {
    const error = new Error('http 502');
    expect(isRetryableRunError(error)).toBe(true);
  });

  it('should identify " 502" as retryable', () => {
    const error = new Error('error:  502');
    expect(isRetryableRunError(error)).toBe(true);
  });

  it('should identify "_502" as retryable', () => {
    const error = new Error('error_code_502');
    expect(isRetryableRunError(error)).toBe(true);
  });

  it('should identify "error code: 500" as retryable', () => {
    const error = new Error('error code: 500');
    expect(isRetryableRunError(error)).toBe(true);
  });

  it('should identify "error code: 503" as retryable', () => {
    const error = new Error('error code: 503');
    expect(isRetryableRunError(error)).toBe(true);
  });

  it('should identify "error code: 504" as retryable', () => {
    const error = new Error('error code: 504');
    expect(isRetryableRunError(error)).toBe(true);
  });

  it('should identify " 408" as retryable', () => {
    const error = new Error('timeout  408');
    expect(isRetryableRunError(error)).toBe(true);
  });

  it('should identify " 429" as retryable', () => {
    const error = new Error('rate limit  429');
    expect(isRetryableRunError(error)).toBe(true);
  });

  it('should identify "No endpoints found ... 404" as retryable for route failover', () => {
    const error = new Error('run_turn failed: responses api returned non-success status: 404; body: No endpoints found for qwen/qwen3.6-plus-preview:free');
    expect(isRetryableRunError(error)).toBe(true);
  });

  it('should NOT identify generic 404 as retryable when no failover signal is present', () => {
    const error = new Error('responses api returned non-success status: 404; body: not found');
    expect(isRetryableRunError(error)).toBe(false);
  });

  it('should NOT identify "error code: 401" as retryable', () => {
    const error = new Error('error code: 401');
    expect(isRetryableRunError(error)).toBe(false);
  });

  it('should NOT identify "error code: 403" as retryable', () => {
    const error = new Error('error code: 403');
    expect(isRetryableRunError(error)).toBe(false);
  });

  it('should NOT identify "unauthorized" as retryable', () => {
    const error = new Error('unauthorized');
    expect(isRetryableRunError(error)).toBe(false);
  });

  it('should NOT identify "insufficient_quota" as retryable', () => {
    const error = new Error('insufficient_quota');
    expect(isRetryableRunError(error)).toBe(false);
  });

  it('should identify "fetch failed" as retryable', () => {
    const error = new Error('fetch failed');
    expect(isRetryableRunError(error)).toBe(true);
  });

  it('should identify "gateway timeout" as retryable', () => {
    const error = new Error('gateway timeout');
    expect(isRetryableRunError(error)).toBe(true);
  });
});

describe('context window inference', () => {
  it('keeps codex model inference for context window', () => {
    expect(__chatCodexInternals.inferModelContextWindow('gpt-5-codex')).toBe(272_000);
    expect(__chatCodexInternals.inferModelContextWindow('gpt-5.1-codex-mini')).toBe(272_000);
  });

  it('does not hardcode generic gpt-5 model context window', () => {
    expect(__chatCodexInternals.inferModelContextWindow('gpt-5')).toBeUndefined();
    expect(__chatCodexInternals.inferModelContextWindow('gpt-5.4')).toBeUndefined();
  });
});
