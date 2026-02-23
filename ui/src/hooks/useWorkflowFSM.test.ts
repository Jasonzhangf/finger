/**
 * useWorkflowFSM Hook 测试 - 简化版
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useWorkflowFSM } from './useWorkflowFSM.js';

// Mock WebSocket
vi.mock('../api/websocket.js', () => ({
  getWebSocket: () => ({
    connect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(() => vi.fn()),
    isConnected: vi.fn().mockReturnValue(true),
  }),
}));

// Mock fetch
global.fetch = vi.fn();

describe('useWorkflowFSM', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should load initial state snapshot', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        workflowId: 'wf-1',
        sessionId: 'session-1',
        fsmState: 'execution',
        simplifiedStatus: 'executing',
        tasks: [
          { id: 't1', fsmState: 'running', simplifiedStatus: 'in_progress', assignee: 'agent-1' },
        ],
        agents: [
          { id: 'agent-1', fsmState: 'running', simplifiedStatus: 'running' },
        ],
        timestamp: new Date().toISOString(),
      }),
    });

    const { result } = renderHook(() => useWorkflowFSM('wf-1', 'session-1'));

    await waitFor(() => {
      expect(result.current.workflow).toBeDefined();
    });

    expect(result.current.workflow?.fsmState).toBe('execution');
    expect(result.current.workflow?.simplifiedStatus).toBe('executing');
    expect(result.current.tasks.length).toBe(1);
    expect(result.current.agents.length).toBe(1);
  });

  it('should apply state mask to hide internal states', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        workflowId: 'wf-1',
        sessionId: 'session-1',
        fsmState: 'semantic_understanding',
        simplifiedStatus: 'planning',
        tasks: [],
        agents: [],
        timestamp: new Date().toISOString(),
      }),
    });

    const { result } = renderHook(() => useWorkflowFSM('wf-1', 'session-1'));

    await waitFor(() => {
      expect(result.current.workflow).toBeDefined();
    });

    // semantic_understanding should be hidden by default mask
    expect(result.current.workflow?.visibleState).toBeNull();
    expect(result.current.workflow?.fsmState).toBe('semantic_understanding');
    expect(result.current.workflow?.simplifiedStatus).toBe('planning');
  });

  it('should handle 404 gracefully', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const { result } = renderHook(() => useWorkflowFSM('wf-1', 'session-1'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.workflow).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('should handle fetch error', async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useWorkflowFSM('wf-1', 'session-1'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Network error');
  });

  it('should allow setting custom mask config', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        workflowId: 'wf-1',
        sessionId: 'session-1',
        fsmState: 'execution',
        simplifiedStatus: 'executing',
        tasks: [],
        agents: [],
        timestamp: new Date().toISOString(),
      }),
    });

    const { result } = renderHook(() => useWorkflowFSM('wf-1', 'session-1'));

    await waitFor(() => {
      expect(result.current.workflow).toBeDefined();
    });

    // Should be able to call setMaskConfig without error
    expect(() => {
      result.current.setMaskConfig({
        workflowStates: { hide: [], showAs: {} },
        taskStates: { hide: [], showAs: {} },
        agentStates: { hide: [], showAs: {} },
        showDetailedStates: true,
      });
    }).not.toThrow();
  });
});
