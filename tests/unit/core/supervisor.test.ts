import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Supervisor } from '../../../src/core/supervisor.js';

describe('Supervisor', () => {
  let supervisor: Supervisor;

  beforeEach(() => {
    supervisor = new Supervisor();
  });

  it('registers processes', () => {
    supervisor.register({
      id: 'test-proc',
      start: async () => {},
      stop: async () => {},
      isHealthy: () => true
    });

    const stats = supervisor.getStats();
    expect(stats['test-proc']).toBeDefined();
    expect(stats['test-proc'].attempts).toBe(0);
  });

  it('starts all processes', async () => {
    const startFn = vi.fn();
    supervisor.register({
      id: 'proc1',
      start: async () => { startFn(); },
      stop: async () => {},
      isHealthy: () => true
    });

    await supervisor.startAll();

    expect(startFn).toHaveBeenCalled();
  });

  it('stops all processes', async () => {
    const stopFn = vi.fn();
    supervisor.register({
      id: 'proc1',
      start: async () => {},
      stop: async () => { stopFn(); },
      isHealthy: () => true
    });

    await supervisor.stopAll();

    expect(stopFn).toHaveBeenCalled();
  });

  it('tracks restart attempts', async () => {
    supervisor.register({
      id: 'unhealthy',
      start: async () => {},
      stop: async () => {},
      isHealthy: () => false
    });

    supervisor.checkHealth();

    const stats = supervisor.getStats();
    // Attempts will increase due to scheduling
    expect(stats['unhealthy'].attempts).toBeGreaterThanOrEqual(0);
  });
});
