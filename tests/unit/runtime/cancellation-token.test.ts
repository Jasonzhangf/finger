import { describe, it, expect } from 'vitest';
import { CancellationToken } from '../../../src/runtime/cancellation-token.js';

describe('CancellationToken', () => {
  it('should start as not cancelled', () => {
    const token = new CancellationToken();
    expect(token.isCancelled).toBe(false);
    expect(token.reason).toBeUndefined();
  });

  it('should cancel with reason', () => {
    const token = new CancellationToken();
    token.cancel('user requested');
    expect(token.isCancelled).toBe(true);
    expect(token.reason).toBe('user requested');
  });

  it('should not cancel twice', () => {
    const token = new CancellationToken();
    token.cancel('first reason');
    token.cancel('second reason');
    expect(token.reason).toBe('first reason');
  });

  it('should notify listeners on cancellation', () => {
    const token = new CancellationToken();
    const calls: string[] = [];
    token.onCancellation((reason) => {
      calls.push(reason);
    });
    token.cancel('test');
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe('test');
  });

  it('should notify listener immediately if already cancelled', () => {
    const token = new CancellationToken();
    token.cancel('already cancelled');
    const calls: string[] = [];
    token.onCancellation((reason) => {
      calls.push(reason);
    });
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe('already cancelled');
  });

  it('should allow unsubscribing', () => {
    const token = new CancellationToken();
    const calls: string[] = [];
    const unsub = token.onCancellation((reason) => {
      calls.push(reason);
    });
    unsub();
    token.cancel('test');
    expect(calls.length).toBe(0);
  });

  it('should throw if cancelled', () => {
    const token = new CancellationToken();
    token.cancel('test');
    expect(() => token.throwIfCancelled()).toThrow('Operation cancelled: test');
  });

  it('should not throw if not cancelled', () => {
    const token = new CancellationToken();
    expect(() => token.throwIfCancelled()).not.toThrow();
  });

  it('should create child token', () => {
    const parent = new CancellationToken();
    const child = parent.createChild();
    expect(child.isCancelled).toBe(false);
  });

  it('should cancel child when parent cancels', () => {
    const parent = new CancellationToken();
    const child = parent.createChild();
    parent.cancel('parent cancelled');
    expect(child.isCancelled).toBe(true);
    expect(child.reason).toContain('Parent cancelled');
  });

  it('should cancel child immediately if parent already cancelled', () => {
    const parent = new CancellationToken();
    parent.cancel('already cancelled');
    const child = parent.createChild();
    expect(child.isCancelled).toBe(true);
    expect(child.reason).toContain('Parent already cancelled');
  });

  it('should cancel multiple children', () => {
    const parent = new CancellationToken();
    const child1 = parent.createChild();
    const child2 = parent.createChild();
    parent.cancel('parent cancelled');
    expect(child1.isCancelled).toBe(true);
    expect(child2.isCancelled).toBe(true);
  });

  it('should create linked token', () => {
    const parent = new CancellationToken();
    const linked = CancellationToken.createLinked(parent);
    expect(linked.isCancelled).toBe(false);
    parent.cancel('parent cancelled');
    expect(linked.isCancelled).toBe(true);
  });
});
