import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Mock fetch
const mockFetch = vi.fn();
(globalThis as Record<string, unknown>).fetch = mockFetch;

// Mock useWebSocket
vi.mock('./useWebSocket.js', () => ({
  useWebSocket: () => ({
    isConnected: true,
    send: vi.fn(),
    subscribe: vi.fn(),
  }),
}));

// Import after mock
import { useResourcePool } from './useResourcePool.js';

describe('useResourcePool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('should fetch resources on mount', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    const { result } = renderHook(() => useResourcePool());
    
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    
    expect(mockFetch).toHaveBeenCalled();
  });

  it('should handle fetch errors', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
    });

    const { result } = renderHook(() => useResourcePool());

    await waitFor(() => {
      expect(result.current.resources).toEqual([]);
    });
  });

  it('should provide refreshResources function', () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    const { result } = renderHook(() => useResourcePool());
    expect(typeof result.current.refreshResources).toBe('function');
  });

  it('should provide deployResource function', () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    const { result } = renderHook(() => useResourcePool());
    expect(typeof result.current.deployResource).toBe('function');
  });

  it('should provide releaseResource function', () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    const { result } = renderHook(() => useResourcePool());
    expect(typeof result.current.releaseResource).toBe('function');
  });
});
