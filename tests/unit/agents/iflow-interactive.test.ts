import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IflowInteractiveAgent, InteractionCallbacks } from '../../../src/agents/sdk/iflow-interactive.js';
import { MessageType } from '@iflow-ai/iflow-cli-sdk';

// Mock IFlowClient
vi.mock('@iflow-ai/iflow-cli-sdk', () => ({
  IFlowClient: vi.fn().mockImplementation(() => ({
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
  })),
  MessageType: {
    ASSISTANT: 'assistant',
    TOOL_CALL: 'tool_call',
    ASK_USER_QUESTIONS: 'ask_user_questions',
    EXIT_PLAN_MODE: 'exit_plan_mode',
    PERMISSION_REQUEST: 'permission_request',
    TASK_FINISH: 'task_finish',
    ERROR: 'error',
  },
}));

describe('IflowInteractiveAgent', () => {
  let agent: IflowInteractiveAgent;
  let mockClient: any;

  beforeEach(async () => {
    const { IFlowClient } = await import('@iflow-ai/iflow-cli-sdk');
    mockClient = new (IFlowClient as any)();
    agent = new IflowInteractiveAgent(mockClient);
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
    const callbacks: InteractionCallbacks = {
      onAssistantChunk: (chunk) => chunks.push(chunk),
    };

    await agent.initialize();
    const result = await agent.interact('test', callbacks);

    expect(result.finalOutput).toContain('Hello');
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('handles tool call with callback', async () => {
    const { IFlowClient, MessageType: MT } = await import('@iflow-ai/iflow-cli-sdk');
    
    // Reset mock for this test
    mockClient.receiveMessages = vi.fn().mockImplementation(async function* () {
      yield { type: MT.TOOL_CALL, toolName: 'test_tool' };
      yield { type: MT.TASK_FINISH, stopReason: 'task_finish' };
    });

    const toolCalls: any[] = [];
    const callbacks: InteractionCallbacks = {
      onToolCall: async (tc) => toolCalls.push(tc),
    };

    await agent.initialize();
    await agent.interact('test', callbacks);

    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].toolName).toBe('test_tool');
  });

  it('handles ask user questions', async () => {
    const { IFlowClient, MessageType: MT } = await import('@iflow-ai/iflow-cli-sdk');
    
    mockClient.receiveMessages = vi.fn().mockImplementation(async function* () {
      yield { type: MT.ASK_USER_QUESTIONS, questions: [{ id: 'q1', text: 'Name?' }] };
      yield { type: MT.TASK_FINISH, stopReason: 'task_finish' };
    });

    const callbacks: InteractionCallbacks = {
      onQuestions: async () => ({ q1: 'Test' }),
    };

    await agent.initialize();
    await agent.interact('test', callbacks);

    expect(mockClient.respondToAskUserQuestions).toHaveBeenCalledWith({ q1: 'Test' });
  });

  it('handles plan approval', async () => {
    const { IFlowClient, MessageType: MT } = await import('@iflow-ai/iflow-cli-sdk');
    
    mockClient.receiveMessages = vi.fn().mockImplementation(async function* () {
      yield { type: MT.EXIT_PLAN_MODE, plan: 'Test plan' };
      yield { type: MT.TASK_FINISH, stopReason: 'task_finish' };
    });

    const callbacks: InteractionCallbacks = {
      onPlan: async () => true,
    };

    await agent.initialize();
    await agent.interact('test', callbacks);

    expect(mockClient.respondToExitPlanMode).toHaveBeenCalledWith(true);
  });

  it('handles permission request', async () => {
    const { IFlowClient, MessageType: MT } = await import('@iflow-ai/iflow-cli-sdk');
    
    mockClient.receiveMessages = vi.fn().mockImplementation(async function* () {
      yield { type: MT.PERMISSION_REQUEST, requestId: 'req-1', options: [{ id: 'allow' }] };
      yield { type: MT.TASK_FINISH, stopReason: 'task_finish' };
    });

    const callbacks: InteractionCallbacks = {
      onPermission: async () => 'allow',
    };

    await agent.initialize();
    await agent.interact('test', callbacks);

    expect(mockClient.respondToToolConfirmation).toHaveBeenCalled();
  });

  it('handles error message', async () => {
    const { IFlowClient, MessageType: MT } = await import('@iflow-ai/iflow-cli-sdk');
    
    mockClient.receiveMessages = vi.fn().mockImplementation(async function* () {
      yield { type: MT.ERROR, message: 'Test error' };
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
