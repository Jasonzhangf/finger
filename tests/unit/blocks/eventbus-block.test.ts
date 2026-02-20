import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBusBlock } from '../../../src/blocks/eventbus-block/index.js';
import type { Event } from '../../../src/core/types.js';

describe('EventBusBlock', () => {
  let block: EventBusBlock;

  beforeEach(() => {
    vi.clearAllMocks();
    block = new EventBusBlock('test-eventbus');
  });

  describe('constructor', () => {
    it('should initialize with id and type', () => {
      expect(block.id).toBe('test-eventbus');
      expect(block.type).toBe('eventbus');
    });

    it('should have correct capabilities', () => {
      expect(block.capabilities.functions).toContain('emit');
      expect(block.capabilities.functions).toContain('subscribe');
      expect(block.capabilities.functions).toContain('unsubscribe');
      expect(block.capabilities.functions).toContain('history');
    });
  });

  describe('emit', () => {
    it('should create and emit an event with auto-generated id and timestamp', async () => {
      const handler = vi.fn();
      block.subscribe('test.event', handler);

      const event = await block.emit({
        type: 'test.event',
        source: 'test',
        payload: { data: 'hello' },
      });

      expect(event.id).toBeDefined();
      expect(event.id).toMatch(/^evt-/);
      expect(event.timestamp).toBeInstanceOf(Date);
      expect(event.type).toBe('test.event');
      expect(event.payload).toEqual({ data: 'hello' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should call all subscribers for event type', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      
      block.subscribe('test.event', handler1);
      block.subscribe('test.event', handler2);

      await block.emit({ type: 'test.event', source: 'test' });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should handle async handlers', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      block.subscribe('test.event', handler);

      await block.emit({ type: 'test.event', source: 'test' });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should not fail when handler throws', async () => {
      const errorHandler = vi.fn().mockRejectedValue(new Error('Handler error'));
      const normalHandler = vi.fn();
      
      block.subscribe('test.event', errorHandler);
      block.subscribe('test.event', normalHandler);

      const event = await block.emit({ type: 'test.event', source: 'test' });

      expect(event).toBeDefined();
      expect(normalHandler).toHaveBeenCalled();
    });

    it('should store events in history', async () => {
      await block.emit({ type: 'event.1', source: 'test' });
      await block.emit({ type: 'event.2', source: 'test' });

      const history = block.getHistory();
      expect(history).toHaveLength(2);
    });
  });

  describe('subscribe', () => {
    it('should register handler and return subscribed status', () => {
      const handler = vi.fn();
      const result = block.subscribe('test.event', handler);

      expect(result.subscribed).toBe(true);
    });

    it('should allow multiple handlers for same type', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      block.subscribe('test.event', handler1);
      block.subscribe('test.event', handler2);

      expect(block.subscribe('test.event', handler1).subscribed).toBe(true);
    });
  });

  describe('unsubscribe', () => {
    it('should remove handler and return unsubscribed status', () => {
      const handler = vi.fn();
      block.subscribe('test.event', handler);

      const result = block.unsubscribe('test.event', handler);

      expect(result.unsubscribed).toBe(true);
    });

    it('should return false when handler not found', () => {
      const handler = vi.fn();
      const result = block.unsubscribe('nonexistent', handler);

      expect(result.unsubscribed).toBe(false);
    });

    it('should stop receiving events after unsubscribe', async () => {
      const handler = vi.fn();
      block.subscribe('test.event', handler);
      block.unsubscribe('test.event', handler);

      await block.emit({ type: 'test.event', source: 'test' });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('getHistory', () => {
    it('should return all events when no type filter', async () => {
      await block.emit({ type: 'event.1', source: 'test' });
      await block.emit({ type: 'event.2', source: 'test' });

      const history = block.getHistory();

      expect(history).toHaveLength(2);
    });

    it('should filter events by type', async () => {
      await block.emit({ type: 'event.1', source: 'test' });
      await block.emit({ type: 'event.2', source: 'test' });
      await block.emit({ type: 'event.1', source: 'test' });

      const history = block.getHistory('event.1');

      expect(history).toHaveLength(2);
      expect(history.every(e => e.type === 'event.1')).toBe(true);
    });

    it('should return empty array when no matching events', () => {
      const history = block.getHistory('nonexistent');
      expect(history).toEqual([]);
    });
  });

  describe('execute', () => {
    it('should handle emit command', async () => {
      const event = await block.execute('emit', { type: 'test.event', source: 'test' });
      expect((event as Event).type).toBe('test.event');
    });

    it('should handle history command', async () => {
      await block.emit({ type: 'test.event', source: 'test' });
      const history = await block.execute('history', {});
      expect(Array.isArray(history)).toBe(true);
      expect(history).toHaveLength(1);
    });

    it('should handle history command with type filter', async () => {
      await block.emit({ type: 'event.1', source: 'test' });
      await block.emit({ type: 'event.2', source: 'test' });
      const history = await block.execute('history', { type: 'event.1' });
      expect(history).toHaveLength(1);
    });

    it('should throw for unknown command', async () => {
      await expect(block.execute('unknown', {})).rejects.toThrow('Unknown command');
    });
  });

  describe('history limit', () => {
    it('should maintain max history limit', async () => {
      const smallBlock = new EventBusBlock('test-small');
      
      for (let i = 0; i < 1100; i++) {
        await smallBlock.emit({ type: 'test.event', source: 'test' });
      }

      const history = smallBlock.getHistory();
      expect(history.length).toBeLessThanOrEqual(1000);
    });
  });
});
