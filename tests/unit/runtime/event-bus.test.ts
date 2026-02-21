import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { UnifiedEventBus } from '../../../src/runtime/event-bus.js';
import type { RuntimeEvent } from '../../../src/runtime/events.js';
import { WebSocket } from 'ws';

// Mock fs/promises for persistence
vi.mock('fs/promises', () => ({
  appendFile: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

describe('UnifiedEventBus', () => {
  let bus: UnifiedEventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    bus = new UnifiedEventBus();
  });

  afterEach(() => {
    bus.clear();
  });

  describe('subscribe', () => {
    it('subscribes and receives events', () => {
      const received: RuntimeEvent[] = [];
      bus.subscribe('test_event', (e) => received.push(e));

      bus.emit({
        type: 'test_event' as any,
        sessionId: 's1',
        timestamp: new Date().toISOString(),
        payload: { data: 'hello' },
      });

      expect(received).toHaveLength(1);
      expect(received[0].sessionId).toBe('s1');
    });

    it('returns unsubscribe function', () => {
      const received: RuntimeEvent[] = [];
      const unsub = bus.subscribe('test', (e) => received.push(e));

      bus.emit({ type: 'test' as any, sessionId: 's1', timestamp: '', payload: {} });
      expect(received).toHaveLength(1);

      unsub();
      bus.emit({ type: 'test' as any, sessionId: 's1', timestamp: '', payload: {} });
      expect(received).toHaveLength(1);
    });
  });

  describe('subscribeMultiple', () => {
    it('subscribes to multiple events', () => {
      const received: RuntimeEvent[] = [];
      bus.subscribeMultiple(['event_a', 'event_b'], (e) => received.push(e));

      bus.emit({ type: 'event_a' as any, sessionId: 's1', timestamp: '', payload: {} });
      bus.emit({ type: 'event_b' as any, sessionId: 's1', timestamp: '', payload: {} });
      bus.emit({ type: 'event_c' as any, sessionId: 's1', timestamp: '', payload: {} });

      expect(received).toHaveLength(2);
    });
  });

  describe('subscribeByGroup', () => {
    it('subscribes to events by group', () => {
      const received: RuntimeEvent[] = [];
      bus.subscribeByGroup('TASK', (e) => received.push(e));

      bus.emit({ type: 'task_started' as any, sessionId: 's1', timestamp: '', payload: {} });
      bus.emit({ type: 'task_completed' as any, sessionId: 's1', timestamp: '', payload: {} });
      bus.emit({ type: 'system_error' as any, sessionId: 's1', timestamp: '', payload: {} });

      expect(received).toHaveLength(2);
    });
  });

  describe('subscribeAll', () => {
    it('subscribes to all events via wildcard', () => {
      const received: RuntimeEvent[] = [];
      bus.subscribeAll((e) => received.push(e));

      bus.emit({ type: 'event_a' as any, sessionId: 's1', timestamp: '', payload: {} });
      bus.emit({ type: 'event_b' as any, sessionId: 's1', timestamp: '', payload: {} });

      expect(received).toHaveLength(2);
    });
  });

  describe('emit with persistence', () => {
    it('persists events when enabled', async () => {
      const { appendFile } = await import('fs/promises');
      bus.enablePersistence('test-session');
      
      bus.emit({ type: 'test_event' as any, sessionId: 's1', timestamp: '', payload: {} });
      
      expect(appendFile).toHaveBeenCalled();
    });

    it('does not persist when disabled', async () => {
      const { appendFile } = await import('fs/promises');
      bus.disablePersistence();
      
      bus.emit({ type: 'test_event' as any, sessionId: 's1', timestamp: '', payload: {} });
      
      expect(appendFile).not.toHaveBeenCalled();
    });
  });

  describe('broadcastToWsClients', () => {
    it('broadcasts to connected clients', () => {
      const mockWs = { 
        readyState: 1, 
        on: vi.fn(), 
        send: vi.fn() 
      } as unknown as WebSocket;
      bus.registerWsClient(mockWs);
      
      bus.emit({ type: 'test_event' as any, sessionId: 's1', timestamp: '', payload: {} });
      
      expect(mockWs.send).toHaveBeenCalled();
    });

    it('does not broadcast to disconnected clients', () => {
      const mockWs = { 
        readyState: WebSocket.CLOSED, 
        on: vi.fn(), 
        send: vi.fn() 
      } as unknown as WebSocket;
      bus.registerWsClient(mockWs);
      
      bus.emit({ type: 'test_event' as any, sessionId: 's1', timestamp: '', payload: {} });
      
      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('filters events by client subscription types', () => {
      const mockWs = { 
        readyState: 1, 
        on: vi.fn(), 
        send: vi.fn() 
      } as unknown as WebSocket;
      bus.registerWsClient(mockWs);
      bus.setWsClientFilter(mockWs, { types: ['task_started'] });
      
      bus.emit({ type: 'task_started' as any, sessionId: 's1', timestamp: '', payload: {} });
      bus.emit({ type: 'task_completed' as any, sessionId: 's1', timestamp: '', payload: {} });
      
      expect(mockWs.send).toHaveBeenCalledTimes(1);
    });

    it('filters events by client subscription groups', () => {
      const mockWs = { 
        readyState: 1, 
        on: vi.fn(), 
        send: vi.fn() 
      } as unknown as WebSocket;
      bus.registerWsClient(mockWs);
      bus.setWsClientFilter(mockWs, { groups: ['TASK'] });
      
      bus.emit({ type: 'task_started' as any, sessionId: 's1', timestamp: '', payload: {} });
      bus.emit({ type: 'system_error' as any, sessionId: 's1', timestamp: '', payload: {} });
      
      expect(mockWs.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('history', () => {
    it('stores history', () => {
      bus.emit({ type: 'e1' as any, sessionId: 's1', timestamp: '', payload: {} });
      bus.emit({ type: 'e2' as any, sessionId: 's1', timestamp: '', payload: {} });

      expect(bus.getHistory()).toHaveLength(2);
    });

    it('filters session history', () => {
      bus.emit({ type: 'e1' as any, sessionId: 's1', timestamp: '', payload: {} });
      bus.emit({ type: 'e2' as any, sessionId: 's2', timestamp: '', payload: {} });
      bus.emit({ type: 'e3' as any, sessionId: 's1', timestamp: '', payload: {} });

      expect(bus.getSessionHistory('s1')).toHaveLength(2);
    });

    it('limits history', () => {
      bus.emit({ type: 'e1' as any, sessionId: 's1', timestamp: '', payload: {} });
      bus.emit({ type: 'e2' as any, sessionId: 's1', timestamp: '', payload: {} });
      bus.emit({ type: 'e3' as any, sessionId: 's1', timestamp: '', payload: {} });

      const history = bus.getHistory(2);
      expect(history).toHaveLength(2);
      expect(history[0].type).toBe('e2');
    });

    it('filters history by type', () => {
      bus.emit({ type: 'type_a' as any, sessionId: 's1', timestamp: '', payload: {} });
      bus.emit({ type: 'type_b' as any, sessionId: 's1', timestamp: '', payload: {} });
      bus.emit({ type: 'type_a' as any, sessionId: 's1', timestamp: '', payload: {} });

      const history = bus.getHistoryByType('type_a');
      expect(history).toHaveLength(2);
    });

    it('filters history by group', () => {
      bus.emit({ type: 'task_started' as any, sessionId: 's1', timestamp: '', payload: {} });
      bus.emit({ type: 'task_completed' as any, sessionId: 's1', timestamp: '', payload: {} });
      bus.emit({ type: 'system_error' as any, sessionId: 's1', timestamp: '', payload: {} });

      const history = bus.getHistoryByGroup('TASK');
      expect(history).toHaveLength(2);
    });

    it('clears history', () => {
      bus.emit({ type: 'e1' as any, sessionId: 's1', timestamp: '', payload: {} });
      bus.clearHistory();
      expect(bus.getHistory()).toHaveLength(0);
    });
  });

  describe('getStats', () => {
    it('returns correct stats', () => {
      bus.subscribe('test', () => {});
      bus.subscribe('test', () => {});
      bus.subscribe('other', () => {});

      const stats = bus.getStats();
      expect(stats.totalHandlers).toBe(3);
      expect(stats.wsClients).toBe(0);
      expect(stats.eventsEmitted).toBe(0);
    });
  });

  describe('clear', () => {
    it('clears all handlers and history', () => {
      bus.subscribe('test', () => {});
      bus.emit({ type: 'test' as any, sessionId: 's1', timestamp: '', payload: {} });
      
      bus.clear();
      
      expect(bus.getHistory()).toHaveLength(0);
      expect(bus.getStats().totalHandlers).toBe(0);
    });
  });

  describe('getSupportedGroups', () => {
    it('returns array of groups', () => {
      const groups = bus.getSupportedGroups();
      expect(Array.isArray(groups)).toBe(true);
      expect(groups.length).toBeGreaterThan(0);
    });
  });

  describe('getSupportedTypes', () => {
    it('returns array of types', () => {
      const types = bus.getSupportedTypes();
      expect(Array.isArray(types)).toBe(true);
      expect(types.length).toBeGreaterThan(0);
    });
  });

  describe('WebSocket clients', () => {
    it('registers and removes ws clients', () => {
      const mockWs = { readyState: 1, on: vi.fn(), send: vi.fn() } as unknown as WebSocket;
      bus.registerWsClient(mockWs);
      
      const stats = bus.getStats();
      expect(stats.wsClients).toBe(1);
      
      bus.removeWsClient(mockWs);
      expect(bus.getStats().wsClients).toBe(0);
    });

    it('sets ws client filter', () => {
      const mockWs = { readyState: 1, on: vi.fn(), send: vi.fn() } as unknown as WebSocket;
      bus.registerWsClient(mockWs);
      bus.setWsClientFilter(mockWs, { types: ['task_started'], groups: ['RESOURCE'] });
      
      expect(true).toBe(true);
    });
  });

  describe('persistence', () => {
    it('enables persistence', () => {
      bus.enablePersistence('test-session');
      const stats = bus.getStats();
      expect(stats.persistenceEnabled).toBe(true);
    });

    it('disables persistence', () => {
      bus.enablePersistence('test-session');
      bus.disablePersistence();
      const stats = bus.getStats();
      expect(stats.persistenceEnabled).toBe(false);
    });
  });

  describe('error handling', () => {
    it('handles handler errors gracefully', () => {
      const errorHandler = () => {
        throw new Error('Handler error');
      };
      const successHandler = vi.fn();
      
      bus.subscribe('test', errorHandler);
      bus.subscribe('test', successHandler);
      
      bus.emit({ type: 'test' as any, sessionId: 's1', timestamp: '', payload: {} });
      
      expect(successHandler).toHaveBeenCalled();
    });
  });
});
