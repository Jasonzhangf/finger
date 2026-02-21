import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Mock fetch
const mockFetch = vi.fn();
(globalThis as Record<string, unknown>).fetch = mockFetch;

// Import after mock
import { useExecutionLogs } from './useExecutionLogs.js';

describe('useExecutionLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch logs on mount', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, logs: [] }),
    });
    const { result } = renderHook(() => useExecutionLogs());
    
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    
    expect(mockFetch).toHaveBeenCalled();
  });

  it('should fetch logs on mount with data', async () => {
    const mockLogs = [
      { sessionId: 's1', agentId: 'a1', agentRole: 'executor', userTask: 'Task 1', startTime: '2023-01-01T00:00:00Z', success: true, iterations: [], totalRounds: 1 },
    ];

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, logs: mockLogs }),
    });

    const { result } = renderHook(() => useExecutionLogs());

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1);
    });

    expect(mockFetch).toHaveBeenCalled();
  });

  it('should handle fetch errors', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
    });

    const { result } = renderHook(() => useExecutionLogs());

    await waitFor(() => {
      expect(result.current.error).toBeTruthy();
    });

    expect(result.current.logs).toEqual([]);
  });

  it('should provide refresh function', () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, logs: [] }),
    });
    const { result } = renderHook(() => useExecutionLogs());
    expect(typeof result.current.refresh).toBe('function');
  });

  it('should provide getLogByAgentId function', () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, logs: [] }),
    });
    const { result } = renderHook(() => useExecutionLogs());
    expect(typeof result.current.getLogByAgentId).toBe('function');
  });

  it('should provide getLatestLog function', () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, logs: [] }),
    });
    const { result } = renderHook(() => useExecutionLogs());
    expect(typeof result.current.getLatestLog).toBe('function');
  });
});
