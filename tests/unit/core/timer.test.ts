import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TimerSystem } from '../../../src/core/timer.js';

describe('TimerSystem', () => {
  let timer: TimerSystem;

  beforeEach(() => {
    timer = new TimerSystem();
  });

  afterEach(() => {
    timer.stopAll();
  });

  it('creates timer', () => {
    const handle = timer.create('test', 1, () => {});
    
    expect(handle.id).toBe('test');
    expect(handle.interval).toBe(1000);
    expect(handle.running).toBe(false);
  });

  it('starts timer and calls callback', async () => {
    const callback = vi.fn();
    timer.create('test', 1, callback);
    
    timer.start('test');
    
    // Wait for first tick
    await new Promise(r => setTimeout(r, 100));
    
    expect(callback).toHaveBeenCalled();
    expect(timer.list()[0].running).toBe(true);
  });

  it('stops timer', async () => {
    timer.create('test', 1, () => {});
    timer.start('test');
    
    timer.stop('test');
    
    expect(timer.list()[0].running).toBe(false);
  });

  it('stops all timers', async () => {
    timer.create('t1', 1, () => {});
    timer.create('t2', 1, () => {});
    timer.start('t1');
    timer.start('t2');
    
    timer.stopAll();
    
    const timers = timer.list();
    expect(timers.every(t => !t.running)).toBe(true);
  });

  it('handles callback errors', async () => {
    const errorCallback = () => { throw new Error('fail'); };
    timer.create('error', 1, errorCallback);
    
    // Should not throw
    timer.start('error');
    await new Promise(r => setTimeout(r, 100));
    
    // Timer should still be running
    expect(timer.list()[0].running).toBe(true);
  });
});
