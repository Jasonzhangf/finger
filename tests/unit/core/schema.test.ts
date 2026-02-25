import { describe, it, expect } from 'vitest';
import { createMessage, CURRENT_VERSION } from '../../../src/core/schema.js';

describe('Message Schema', () => {
  it('creates message with required fields', () => {
    const msg = createMessage('test', { foo: 'bar' }, 'unit-test');
    
    expect(msg.version).toBe(CURRENT_VERSION);
    expect(msg.type).toBe('test');
    expect(msg.payload).toEqual({ foo: 'bar' });
    expect(msg.meta.id).toBeDefined();
    expect(msg.meta.timestamp).toBeGreaterThan(0);
    expect(msg.meta.source).toBe('unit-test');
  });

  it('creates message with optional dest', () => {
    const msg = createMessage('cmd', {}, 'src', { dest: 'dst' });
    
    expect(msg.meta.dest).toBe('dst');
  });

  it('creates message with traceId', () => {
    const msg = createMessage('cmd', {}, 'src', { traceId: 'trace-123' });
    
    expect(msg.meta.traceId).toBe('trace-123');
  });

  it('generates unique IDs', () => {
    const msg1 = createMessage('t', {}, 's');
    const msg2 = createMessage('t', {}, 's');
    
    expect(msg1.meta.id).not.toBe(msg2.meta.id);
  });
});
