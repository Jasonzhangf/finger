import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Mock API functions
const mockListSessions = vi.fn();
const mockCreateSession = vi.fn();
const mockDeleteSession = vi.fn();
const mockRenameSession = vi.fn();
const mockSetCurrentSession = vi.fn();
const mockGetCurrentSession = vi.fn();

vi.mock('../api/client.js', () => ({
  listSessions: () => mockListSessions(),
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  deleteSession: (...args: unknown[]) => mockDeleteSession(...args),
  renameSession: (...args: unknown[]) => mockRenameSession(...args),
  setCurrentSession: (...args: unknown[]) => mockSetCurrentSession(...args),
  getCurrentSession: () => mockGetCurrentSession(),
}));

// Import after mock
import { useSessions } from './useSessions.js';

describe('useSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentSession.mockRejectedValue(new Error('No current session'));
  });

  it('should fetch sessions on mount', async () => {
    mockListSessions.mockResolvedValue([]);
    const { result } = renderHook(() => useSessions());
    
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    
    expect(mockListSessions).toHaveBeenCalled();
  });

  it('should fetch sessions on mount with data', async () => {
    const mockSessions = [
      { id: 'session-1', name: 'Session 1', projectPath: '/path/1', createdAt: '2023-01-01T00:00:00Z', updatedAt: '2023-01-01T00:00:00Z', lastAccessedAt: '2023-01-01T00:00:00Z', messageCount: 0, activeWorkflows: [] },
    ];

    mockListSessions.mockResolvedValue(mockSessions);

    const { result } = renderHook(() => useSessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    expect(mockListSessions).toHaveBeenCalled();
  });

  it('should prefer server current session when available', async () => {
    const mockSessions = [
      { id: 'session-1', name: 'Session 1', projectPath: '/path/1', createdAt: '2023-01-01T00:00:00Z', updatedAt: '2023-01-01T00:00:00Z', lastAccessedAt: '2023-01-01T00:00:00Z', messageCount: 0, activeWorkflows: [] },
      { id: 'session-2', name: 'Session 2', projectPath: '/path/2', createdAt: '2023-01-01T00:00:00Z', updatedAt: '2023-01-01T00:00:00Z', lastAccessedAt: '2023-01-02T00:00:00Z', messageCount: 0, activeWorkflows: [] },
    ];
    mockListSessions.mockResolvedValue(mockSessions);
    mockGetCurrentSession.mockResolvedValue(mockSessions[0]);

    const { result } = renderHook(() => useSessions());

    await waitFor(() => {
      expect(result.current.currentSession?.id).toBe('session-1');
    });
  });

  it('should handle fetch errors', async () => {
    mockListSessions.mockRejectedValue(new Error('API error'));

    const { result } = renderHook(() => useSessions());

    await waitFor(() => {
      expect(result.current.error).toBe('API error');
    });

    expect(result.current.sessions).toEqual([]);
  });

  it('should provide create function', () => {
    mockListSessions.mockResolvedValue([]);
    const { result } = renderHook(() => useSessions());
    expect(typeof result.current.create).toBe('function');
  });

  it('should provide remove function', () => {
    mockListSessions.mockResolvedValue([]);
    const { result } = renderHook(() => useSessions());
    expect(typeof result.current.remove).toBe('function');
  });

  it('should provide rename function', () => {
    mockListSessions.mockResolvedValue([]);
    const { result } = renderHook(() => useSessions());
    expect(typeof result.current.rename).toBe('function');
  });

  it('should provide switchSession function', () => {
    mockListSessions.mockResolvedValue([]);
    const { result } = renderHook(() => useSessions());
    expect(typeof result.current.switchSession).toBe('function');
  });
});
