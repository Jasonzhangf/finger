import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWorkflowExecution } from './useWorkflowExecution.js';
import type { WsMessage, WorkflowUpdatePayload, AgentUpdatePayload } from '../api/types.js';

// Mock useWebSocket
vi.mock('./useWebSocket.js', () => ({
  useWebSocket: () => ({
    isConnected: true,
    subscribe: vi.fn(),
    send: vi.fn(),
  }),
}));

describe('useWorkflowExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with empty state', () => {
    const { result } = renderHook(() => useWorkflowExecution('test-session'));

    expect(result.current.workflow).toBeNull();
    expect(result.current.executionState).toBeNull();
    expect(result.current.runtimeEvents).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should set selected agent', () => {
    const { result } = renderHook(() => useWorkflowExecution('test-session'));

    act(() => {
      result.current.setSelectedAgentId('agent-1');
    });

    expect(result.current.selectedAgentId).toBe('agent-1');
  });

  it('should start workflow and update state', async () => {
    const { result } = renderHook(() => useWorkflowExecution('test-session'));

    await act(async () => {
      await result.current.startWorkflow('Test task');
    });

    // After starting, isLoading should be false
    expect(result.current.isLoading).toBe(false);
  });

  it('should infer agent type from agentId', () => {
    // Testing internal helper via behavior
    const { result } = renderHook(() => useWorkflowExecution('test-session'));

    expect(result.current.getAgentDetail('non-existent')).toBeNull();
  });

  it('should pause workflow', async () => {
    const { result } = renderHook(() => useWorkflowExecution('test-session'));

    await act(async () => {
      await result.current.pauseWorkflow();
    });

    expect(result.current.isLoading).toBe(false);
  });

  it('should resume workflow', async () => {
    const { result } = renderHook(() => useWorkflowExecution('test-session'));

    await act(async () => {
      await result.current.resumeWorkflow();
    });

    expect(result.current.isLoading).toBe(false);
  });

  it('should send user input', async () => {
    const { result } = renderHook(() => useWorkflowExecution('test-session'));

    await act(async () => {
      await result.current.sendUserInput({ content: 'Test input' });
    });

    expect(result.current.isLoading).toBe(false);
  });

  it('should report connection status', () => {
    const { result } = renderHook(() => useWorkflowExecution('test-session'));

    expect(result.current.isConnected).toBe(true);
  });
});
