
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TimerInput } from '../../../src/inputs/timer.js';

describe('TimerInput', () => {
  let input: TimerInput;

  beforeEach(() => {
    input = new TimerInput('test-timer', {
      interval: 1, // 1 second
      type: 'heartbeat',
      payload: { ping: true }
    });
  });

  afterEach(async () => {
    await input.stop();
  });

  it('creates with correct id', () => {
    expect(input.id).toBe('test-timer');
  });

it('starts and emits messages', async () => {
    const messages: unknown[] = [];
    input.setEmitter(async (msg) => {
      messages.push(msg);
    });

    await input.start();

    // Wait for first tick
    await new Promise(r => setTimeout(r, 100));

    expect(messages.length).toBeGreaterThan(0);
    const msg = messages[0] as { type: string; payload: unknown; meta: { source: string } };
    expect(msg.type).toBe('heartbeat');
    expect(msg.payload).toEqual({ ping: true });
    expect(msg.meta.source).toBe('test-timer');
  });

  it('stops emitting after stop', async () => {
    const messages: unknown[] = [];
    input.setEmitter(async (msg) => {
      messages.push(msg);
    });

    await input.start();
    await new Promise(r => setTimeout(r, 150));
    await input.stop();

    const countAfterStop = messages.length;
    await new Promise(r => setTimeout(r, 200));

    expect(messages.length).toBe(countAfterStop);
  });

  it('reports running state', async () => {
    expect(input.isRunning()).toBe(false);
    
    await input.start();
    expect(input.isRunning()).toBe(true);
    
    await input.stop();
    expect(input.isRunning()).toBe(false);
  });
});
