import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Mock listModules API
const mockListModules = vi.fn();
vi.mock('../api/client.js', () => ({
  listModules: () => mockListModules(),
}));

// Import after mock
import { useAgents } from './useAgents.js';

describe('useAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch agents on mount', async () => {
    mockListModules.mockResolvedValue({ modules: [] });
    const { result } = renderHook(() => useAgents());
    
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    
    expect(mockListModules).toHaveBeenCalled();
  });

  it('should fetch agents on mount with data', async () => {
    const mockModules = [
      { id: 'agent-1', name: 'Agent 1', type: 'output' as const, version: '1.0.0' },
      { id: 'agent-2', name: 'Agent 2', type: 'agent' as const, version: '1.0.0' },
    ];

    mockListModules.mockResolvedValue({ modules: mockModules });

    const { result } = renderHook(() => useAgents());

    await waitFor(() => {
      expect(result.current.agents).toHaveLength(2);
    });

    expect(mockListModules).toHaveBeenCalled();
  });

  it('should handle fetch errors', async () => {
    mockListModules.mockRejectedValue(new Error('API error'));

    const { result } = renderHook(() => useAgents());

    await waitFor(() => {
      expect(result.current.error).toBe('API error');
    });

    expect(result.current.agents).toEqual([]);
  });

  it('should provide refresh function', () => {
    mockListModules.mockResolvedValue({ modules: [] });
    const { result } = renderHook(() => useAgents());
    expect(typeof result.current.refresh).toBe('function');
  });

  it('should transform modules to agents', async () => {
    const mockModules = [
      { id: 'agent-1', name: 'Agent 1', type: 'output' as const, version: '1.0.0' },
    ];

    mockListModules.mockResolvedValue({ modules: mockModules });

    const { result } = renderHook(() => useAgents());

    await waitFor(() => {
      expect(result.current.agents).toHaveLength(1);
    });

    expect(result.current.agents[0]).toMatchObject({
      id: 'agent-1',
      status: 'idle',
      load: 0,
    });
  });
});
