import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IflowInteractiveAgent } from '../../../src/agents/sdk/iflow-interactive.js';
import { MessageType } from '@iflow-ai/iflow-cli-sdk';

// Mock IFlowClient
const createMockClient = () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  receiveMessages: vi.fn().mockImplementation(async function* () {
    yield { type: MessageType.ASSISTANT, chunk: { text: 'Hello' } };
    yield { type: MessageType.TASK_FINISH, stopReason: 'task_finish' };
  }),
  respondToAskUserQuestions: vi.fn().mockResolvedValue(undefined),
  respondToExitPlanMode: vi.fn().mockResolvedValue(undefined),
  respondToToolConfirmation: vi.fn().mockResolvedValue(undefined),
  cancelToolConfirmation: vi.fn().mockResolvedValue(undefined),
  interrupt: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn().mockReturnValue(true),
});

describe('IflowInteractiveAgent', () => {
  let agent: IflowInteractiveAgent;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    agent = new IflowInteractiveAgent(mockClient as any);
  });

  it('initializes successfully', async () => {
    await agent.initialize();
    expect(mockClient.connect).toHaveBeenCalled();
  });

  it('disconnects successfully', async () => {
    await agent.disconnect();
    expect(mockClient.disconnect).toHaveBeenCalled();
  });

  it('handles assistant message', async () => {
    const chunks: string[] = [];
    await agent.initialize();
    const result = await agent.interact('test', {
      onAssistantChunk: (chunk) => chunks.push(chunk),
    });

    expect(result.finalOutput).toContain('Hello');
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('handles tool call with callback', async () => {
    mockClient.receiveMessages = vi.fn().mockImplementation(async function* () {
      yield { type: MessageType.TOOL_CALL, toolName: 'test_tool' };
      yield { type: MessageType.TASK_FINISH, stopReason: 'task_finish' };
    });

    const toolCalls: any[] = [];
    await agent.initialize();
    await agent.interact('test', {
      onToolCall: async (tc) => toolCalls.push(tc),
    });

    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].toolName).toBe('test_tool');
  });

  it('handles ask user questions', async () => {
    mockClient.receiveMessages = vi.fn().mockImplementation(async function* () {
      yield { type: MessageType.ASK_USER_QUESTIONS, questions: [{ id: 'q1', text: 'Name?' }] };
      yield { type: MessageType.TASK_FINISH, stopReason: 'task_finish' };
    });

    await agent.initialize();
    await agent.interact('test', {
      onQuestions: async () => ({ q1: 'Test' }),
    });

    expect(mockClient.respondToAskUserQuestions).toHaveBeenCalledWith({ q1: 'Test' });
  });

  it('handles plan approval', async () => {
    mockClient.receiveMessages = vi.fn().mockImplementation(async function* () {
      yield { type: MessageType.EXIT_PLAN_MODE, plan: 'Test plan' };
      yield { type: MessageType.TASK_FINISH, stopReason: 'task_finish' };
    });

    await agent.initialize();
    await agent.interact('test', {
      onPlan: async () => true,
    });

    expect(mockClient.respondToExitPlanMode).toHaveBeenCalledWith(true);
  });

  it('handles permission request', async () => {
    mockClient.receiveMessages = vi.fn().mockImplementation(async function* () {
      yield { type: MessageType.PERMISSION_REQUEST, requestId: 'req-1', options: [{ id: 'allow' }] };
      yield { type: MessageType.TASK_FINISH, stopReason: 'task_finish' };
    });

    await agent.initialize();
    await agent.interact('test', {
      onPermission: async () => 'allow',
    });

    expect(mockClient.respondToToolConfirmation).toHaveBeenCalled();
  });

  it('handles error message', async () => {
    mockClient.receiveMessages = vi.fn().mockImplementation(async function* () {
      yield { type: MessageType.ERROR, message: 'Test error' };
    });

    await agent.initialize();
    await expect(agent.interact('test')).rejects.toThrow('iFlow error: Test error');
  });

  it('interrupts running task', async () => {
    await agent.initialize();
    await agent.interrupt();
    expect(mockClient.interrupt).toHaveBeenCalled();
  });
});
