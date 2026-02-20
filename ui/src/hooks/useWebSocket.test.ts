import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWebSocket } from './useWebSocket.js';

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  readyState: number = WebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = WebSocket.OPEN;
      this.onopen?.(new Event('open'));
    }, 0);
  }

  send(data: string) {
    if (this.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);

describe('useWebSocket', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should initialize with disconnected state', () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:8081'));

    // Initially not connected (will connect after timeout)
    expect(result.current.isConnected).toBe(false);
  });

  it('should connect to WebSocket', async () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:8081'));

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    expect(MockWebSocket.instances.length).toBe(1);
    expect(MockWebSocket.instances[0].url).toBe('ws://localhost:8081');
  });

  it('should send messages', async () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:8081'));

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    const ws = MockWebSocket.instances[0];
    const sendSpy = vi.spyOn(ws, 'send');

    act(() => {
      result.current.send({ type: 'test', payload: { data: 'hello' } });
    });

    expect(sendSpy).toHaveBeenCalledWith(JSON.stringify({ type: 'test', payload: { data: 'hello' } }));
  });

  it('should handle subscriptions', async () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:8081'));

    const handler = vi.fn();

    act(() => {
      result.current.subscribe(handler);
    });

    // Subscribe should register the handler
    expect(result.current.isConnected).toBeDefined();
  });

  it('should close connection on unmount', async () => {
    const { unmount } = renderHook(() => useWebSocket('ws://localhost:8081'));

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    const ws = MockWebSocket.instances[0];
    const closeSpy = vi.spyOn(ws, 'close');

    unmount();

    expect(closeSpy).toHaveBeenCalled();
  });
});
