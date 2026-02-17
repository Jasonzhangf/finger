import { describe, it, expect, beforeEach } from 'vitest';
import { UnifiedEventBus } from '../../../src/runtime/event-bus.js';
import type { RuntimeEvent } from '../../../src/runtime/events.js';

describe('UnifiedEventBus', () => {
  let bus: UnifiedEventBus;

  beforeEach(() => {
    bus = new UnifiedEventBus();
  });

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

  it('subscribes to multiple events', () => {
    const received: RuntimeEvent[] = [];
    bus.subscribeMultiple(['event_a', 'event_b'], (e) => received.push(e));

    bus.emit({ type: 'event_a' as any, sessionId: 's1', timestamp: '', payload: {} });
    bus.emit({ type: 'event_b' as any, sessionId: 's1', timestamp: '', payload: {} });
    bus.emit({ type: 'event_c' as any, sessionId: 's1', timestamp: '', payload: {} });

    expect(received).toHaveLength(2);
  });

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

  it('returns unsubscribe function', () => {
    const received: RuntimeEvent[] = [];
    const unsub = bus.subscribe('test', (e) => received.push(e));

    bus.emit({ type: 'test' as any, sessionId: 's1', timestamp: '', payload: {} });
    expect(received).toHaveLength(1);

    unsub();
    bus.emit({ type: 'test' as any, sessionId: 's1', timestamp: '', payload: {} });
    expect(received).toHaveLength(1); // still 1, unsubscribed
  });
});
