import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
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
        tools: [
          expect.objectContaining({
            name: 'exec_command',
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
    await module.handle({ text: 'stream reasoning test' });

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
    await module.handle({ text: 'stream realtime reasoning test' });

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

  it('maps project-like roles onto orchestrator developer instructions', () => {
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

    expect(executor).toContain('role=orchestrator');
    expect(searcher).toContain('role=orchestrator');
    expect(executor).toContain('[context_ledger]');
    expect(searcher).toContain('[context_ledger]');
    expect(executor).toBe(searcher);
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

    expect(instructions).toContain('Current prompt history is a budgeted dynamic view, not the full ledger.');
    expect(instructions).toContain('working_set contains the active task block at higher fidelity; historical_memory contains relevance-selected prior blocks.');
    expect(instructions).toContain('When historical context is missing, first call `context_ledger.memory` with action="search"');
    expect(instructions).toContain('Do not guess hidden history; retrieve evidence from ledger first.');
    expect(instructions).toContain('working_set_task_blocks=1');
    expect(instructions).toContain('historical_task_blocks=2');
    expect(instructions).toContain('working_set_tokens=500');
    expect(instructions).toContain('historical_tokens=1500');
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
      target: { type: 'string', enum: ['project', 'reviewer', 'system'] },
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

  it('loads FLOW.md with hard 10k-char truncation controlled by code', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'finger-flow-test-'));
    const flowPath = join(tempDir, 'FLOW.md');
    const overLimit = `${'A'.repeat(10_050)}\nEND`;
    writeFileSync(flowPath, overLimit, 'utf-8');

    try {
      const options = __chatCodexInternals.buildKernelUserTurnOptions(
        {
          sessionId: 'session-1',
          metadata: {
            roleProfile: 'orchestrator',
            kernelMode: 'main',
            skillsPromptEnabled: false,
            mailboxPromptEnabled: false,
            flowFilePath: flowPath,
          },
        },
        undefined,
      );

      const instructions = options?.developer_instructions ?? '';
      expect(instructions).toContain('# Task Flow Runtime');
      expect(instructions).toContain('...[TRUNCATED_AT_10000_CHARS]');
      expect(instructions).toContain(`FLOW.path=${flowPath}`);

      const fenceStart = instructions.indexOf('```md');
      const fenceEnd = instructions.indexOf('```', fenceStart + 5);
      expect(fenceStart).toBeGreaterThanOrEqual(0);
      expect(fenceEnd).toBeGreaterThan(fenceStart);
      const fencedContent = instructions.slice(fenceStart + '```md\n'.length, fenceEnd).trimEnd();
      expect(fencedContent.startsWith('A'.repeat(10_000))).toBe(true);
      expect(fencedContent).not.toContain('END');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not inject FLOW block when flow prompt is disabled', () => {
    const options = __chatCodexInternals.buildKernelUserTurnOptions(
      {
        sessionId: 'session-1',
        metadata: {
          roleProfile: 'orchestrator',
          kernelMode: 'main',
          flowPromptEnabled: false,
          skillsPromptEnabled: false,
          mailboxPromptEnabled: false,
        },
      },
      undefined,
    );

    expect(options?.developer_instructions ?? '').not.toContain('# Task Flow Runtime');
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
