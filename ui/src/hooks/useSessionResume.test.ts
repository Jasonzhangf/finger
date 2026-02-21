import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mock
import { useSessionResume } from './useSessionResume.js';

describe('useSessionResume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with no resume state', () => {
    const { result } = renderHook(() => useSessionResume());
    expect(result.current.hasResumeableSession).toBeNull();
    expect(result.current.isResuming).toBe(false);
  });

  it('should check for resumable session', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        resumeContext: {
          checkpoint: { checkpointId: 'cp-1', sessionId: 's1', timestamp: '2023-01-01T00:00:00Z', originalTask: 'Task', completedTaskIds: [], failedTaskIds: [], pendingTaskIds: [] },
          summary: 'Summary',
          nextActions: [],
          estimatedProgress: 50,
        },
      }),
    });

    const { result } = renderHook(() => useSessionResume());

    await act(async () => {
      await result.current.checkForResumeableSession('test-session');
    });

    expect(mockFetch).toHaveBeenCalled();
    expect(result.current.hasResumeableSession).toBe(true);
  });

  it('should handle no checkpoint (404)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    });

    const { result } = renderHook(() => useSessionResume());

    await act(async () => {
      await result.current.checkForResumeableSession('test-session');
    });

    expect(result.current.hasResumeableSession).toBe(false);
  });

  it('should provide resumeSession function', () => {
    const { result } = renderHook(() => useSessionResume());
    expect(typeof result.current.resumeSession).toBe('function');
  });

  it('should provide createCheckpoint function', () => {
    const { result } = renderHook(() => useSessionResume());
    expect(typeof result.current.createCheckpoint).toBe('function');
  });
});
