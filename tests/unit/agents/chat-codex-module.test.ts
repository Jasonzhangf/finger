import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __chatCodexInternals,
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
    const module = createChatCodexModule({ onLoopEvent }, runner);

    const result = await module.handle({ text: 'retry timeout' });
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
    const module = createChatCodexModule({}, runner);

    const result = await module.handle({ text: 'retry timeout fail' });
    const payload = asRecord(result);

    expect(runTurnMock).toHaveBeenCalledTimes(6);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe('chat-codex timed out after 600000ms');
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
    await module.handle({ text: 'stream test' });

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

  it('keeps system prompt stable across orchestrator and reviewer roles', async () => {
    runTurnMock.mockResolvedValue({
      reply: 'OK',
      events: [],
      usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
    });
    const module = createChatCodexModule({}, runner);

    await module.handle({ text: 'orchestrate this', roleProfile: 'orchestrator' });
    await module.handle({ text: 'review this', roleProfile: 'reviewer' });

    expect(runTurnMock).toHaveBeenCalledTimes(2);
    const firstPrompt = runTurnMock.mock.calls[0][2]?.systemPrompt;
    const secondPrompt = runTurnMock.mock.calls[1][2]?.systemPrompt;
    expect(typeof firstPrompt).toBe('string');
    expect(firstPrompt).toBe(secondPrompt);
  });

  it('builds role-specific developer instructions with ledger block in developer zone', () => {
    const orchestrator = __chatCodexInternals.buildKernelUserTurnOptions(
      {
        sessionId: 'session-1',
        metadata: {
          roleProfile: 'orchestrator',
          contextLedgerEnabled: true,
          contextLedgerAgentId: 'chat-codex',
          contextLedgerRole: 'orchestrator',
          kernelMode: 'main',
        },
      },
      undefined,
    );
    const reviewer = __chatCodexInternals.buildKernelUserTurnOptions(
      {
        sessionId: 'session-1',
        metadata: {
          roleProfile: 'reviewer',
          contextLedgerEnabled: true,
          contextLedgerAgentId: 'chat-codex',
          contextLedgerRole: 'reviewer',
          kernelMode: 'main',
        },
      },
      undefined,
    );

    expect(orchestrator?.developer_instructions).toContain('role=orchestrator');
    expect(orchestrator?.developer_instructions).toContain('[context_ledger]');
    expect(reviewer?.developer_instructions).toContain('role=reviewer');
    expect(reviewer?.developer_instructions).toContain('[context_ledger]');
    expect(orchestrator?.developer_instructions).not.toBe(reviewer?.developer_instructions);
  });

  it('supports executor and searcher developer role templates', () => {
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

    expect(executor).toContain('role=executor');
    expect(searcher).toContain('role=searcher');
    expect(executor).not.toBe(searcher);
  });

  it('grants orchestrator documentation write tool and keeps reviewer read-only', async () => {
    runTurnMock.mockResolvedValue({
      reply: 'OK',
      events: [],
      usedBinaryPath: '/tmp/finger-kernel-bridge-bin',
    });
    const module = createChatCodexModule({}, runner);

    await module.handle({ text: 'write plan doc', roleProfile: 'orchestrator' });
    await module.handle({ text: 'review only', roleProfile: 'reviewer' });

    const orchestratorTools = (runTurnMock.mock.calls[0][2]?.tools ?? []).map((item) => item.name);
    const reviewerTools = (runTurnMock.mock.calls[1][2]?.tools ?? []).map((item) => item.name);

    expect(orchestratorTools).toContain('apply_patch');
    expect(orchestratorTools).toContain('update_plan');
    expect(reviewerTools).not.toContain('apply_patch');
  });

  it('keeps structured output schema disabled by default', () => {
    const options = __chatCodexInternals.buildKernelUserTurnOptions(
      {
        sessionId: 'session-1',
        metadata: {
          roleProfile: 'orchestrator',
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
          roleProfile: 'reviewer',
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
      role: { type: 'string', const: 'reviewer' },
      reviewLevel: { type: 'string', enum: ['feedback', 'soft_gate', 'hard_gate'] },
      target: { type: 'string', enum: ['executor', 'orchestrator', 'general'] },
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
});
