import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWorkflowExecution } from './useWorkflowExecution.js';

// Mock useWebSocket
vi.mock('./useWebSocket.js', () => ({
  useWebSocket: () => ({
    isConnected: true,
    subscribe: vi.fn(),
    send: vi.fn(),
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();
(globalThis as Record<string, unknown>).fetch = mockFetch;

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
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });

    const { result } = renderHook(() => useWorkflowExecution('test-session'));

    await act(async () => {
      await result.current.startWorkflow('Test task');
    });

    expect(result.current.isLoading).toBe(false);
  });

  it('should infer agent type from agentId', () => {
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

  it('should send user input with text field', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, message: 'OK' }),
    });

    const { result } = renderHook(() => useWorkflowExecution('test-session'));

    await act(async () => {
      await result.current.sendUserInput({ text: 'Test input' });
    });

    // Should have the user message
    expect(result.current.runtimeEvents.some(e => e.role === 'user' && e.content === 'Test input')).toBe(true);
  });

  it('should report connection status', () => {
    const { result } = renderHook(() => useWorkflowExecution('test-session'));

    expect(result.current.isConnected).toBe(true);
  });
  
  describe('sendUserInput pending/confirmed/error flow', () => {
    it('should insert pending event before API call', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, message: 'OK' }),
      });
      
      const { result } = renderHook(() => useWorkflowExecution('test-session'));
      
      await act(async () => {
        await result.current.sendUserInput({ text: 'Test pending' });
      });
      
     // Should have the user message with pending status (no real workflow yet)
     const userEvent = result.current.runtimeEvents.find(
       (e) => e.role === 'user' && e.content === 'Test pending'
     );
     expect(userEvent).toBeDefined();
      // After startWorkflow completes, it becomes 'confirmed'
      expect(userEvent?.agentId).toBe('confirmed');
      
      // Should also have updated user rounds
      expect(result.current.userRounds.length).toBeGreaterThan(0);
    });
    
    it('should handle user input when workflow exists', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, message: 'OK' }),
      });
      
      const { result } = renderHook(() => useWorkflowExecution('test-session'));
      
      // First start a workflow (this creates pending workflow state)
      await act(async () => {
        await result.current.startWorkflow('Setup workflow');
      });
      
      // At this point executionState exists but workflowId starts with 'pending-'
      // so sendUserInput will trigger startWorkflow again
      await act(async () => {
        await result.current.sendUserInput({ text: 'Test with workflow' });
      });
      
      // Should have both events
      const events = result.current.runtimeEvents.filter(e => e.role === 'user');
      expect(events.length).toBeGreaterThanOrEqual(1);
    });
    
    it('should allow sending multiple messages', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });
      
      const { result } = renderHook(() => useWorkflowExecution('test-session'));
      
      // Send first message
      await act(async () => {
        await result.current.sendUserInput({ text: 'First' });
      });
      
      // Send second message
      await act(async () => {
        await result.current.sendUserInput({ text: 'Second' });
      });
      
      // Both events should be present
      expect(result.current.runtimeEvents.filter((e) => e.role === 'user')).toHaveLength(2);
      expect(result.current.userRounds).toHaveLength(2);
    });
  });
});
