import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWebSocket } from './useWebSocket.js';
import { getWebSocket } from '../api/websocket.js';

// Mock the WebSocketClient
vi.mock('../api/websocket.js', () => {
  const mockWs = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    send: vi.fn(),
    isConnected: vi.fn().mockReturnValue(false),
    onMessage: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}),
  };
  
  return {
    WebSocketClient: vi.fn(() => mockWs),
    getWebSocket: vi.fn(() => mockWs),
  };
});

describe('useWebSocket', () => {
  let mockWs: ReturnType<typeof getWebSocket>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWs = getWebSocket();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should initialize with disconnected state', () => {
    const onMessage = vi.fn();
    const { result } = renderHook(() => useWebSocket(onMessage));

    expect(result.current.isConnected).toBe(false);
  });

  it('should connect to WebSocket on mount', async () => {
    const onMessage = vi.fn();
    renderHook(() => useWebSocket(onMessage));

    expect(mockWs.connect).toHaveBeenCalled();
    expect(mockWs.onMessage).toHaveBeenCalled();
  });

  it('should send messages', () => {
    const onMessage = vi.fn();
    const { result } = renderHook(() => useWebSocket(onMessage));

    act(() => {
      result.current.send({ type: 'test', payload: { data: 'hello' } });
    });

    expect(mockWs.send).toHaveBeenCalledWith({ type: 'test', payload: { data: 'hello' } });
  });

  it('should register message handler', () => {
    const onMessage = vi.fn();
    renderHook(() => useWebSocket(onMessage));

    expect(mockWs.onMessage).toHaveBeenCalled();
  });

  it('should unsubscribe on unmount', () => {
    const onMessage = vi.fn();
    const unsubscribe = vi.fn();
    (mockWs.onMessage as ReturnType<typeof vi.fn>).mockReturnValue(unsubscribe);
    
    const { unmount } = renderHook(() => useWebSocket(onMessage));
    unmount();

    expect(unsubscribe).toHaveBeenCalled();
  });
});
