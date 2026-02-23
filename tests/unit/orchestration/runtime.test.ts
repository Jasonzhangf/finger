/**
 * Unit tests for AgentRuntime lifecycle manager.
 *
 * Covers RUNTIME_SPEC.md section 5:
 * - Agent registration and state transitions
 * - Start / stop / restart flows
 * - Health check injection
 * - Auto-restart with backoff
 * - History persistence
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRuntime, type AgentConfig, type HealthChecker } from '../../../src/orchestration/runtime.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mockSpawn = vi.fn();
const mockProc = {
  pid: 12345,
  on: vi.fn(),
  once: vi.fn(),
  kill: vi.fn(),
  unref: vi.fn(),
};

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => {
    mockSpawn(...args);
    return mockProc;
  },
}));

vi.mock('../../../src/agents/core/agent-lifecycle.js', () => ({
  lifecycleManager: {
    registerProcess: vi.fn(),
    killProcess: vi.fn(),
    cleanupOrphanProcesses: vi.fn(() => ({ killed: [], errors: [] })),
  },
}));

const tempHistoryFile = path.join(os.tmpdir(), `agent-history-${Date.now()}.json`);

class MockHealthChecker implements HealthChecker {
  public healthy = true;
  async check(_agentId: string, _port: number, _timeoutMs: number): Promise<boolean> {
    return this.healthy;
  }
}

describe('AgentRuntime', () => {
  let runtime: AgentRuntime;
  let checker: MockHealthChecker;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockClear();
    mockProc.on.mockClear();
    mockProc.once.mockClear();
    mockProc.kill.mockClear();

    checker = new MockHealthChecker();
    runtime = new AgentRuntime({ historyFile: tempHistoryFile }, checker);
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tempHistoryFile);
    } catch {
      // Ignore
    }
  });

  describe('register', () => {
    it('should register agent with normalized config', () => {
      const cfg: AgentConfig = {
        id: 'agent-1',
        name: 'Agent One',
        port: 5001,
        command: 'node',
      };
      runtime.register(cfg);
      const state = runtime.getState('agent-1');
      expect(state).toBeDefined();
      expect(state?.state).toBe('REGISTERED');
      expect(state?.config.port).toBe(5001);
      expect(state?.config.autoRestart).toBe(true);
    });

    it('should reject duplicate registration', () => {
      runtime.register({ id: 'dup', name: 'Dup', port: 5002, command: 'node' });
      expect(() => runtime.register({ id: 'dup', name: 'Dup', port: 5002, command: 'node' })).toThrow(
        'already registered'
      );
    });
  });

  describe('start', () => {
    it('should spawn process and transition to RUNNING', async () => {
      runtime.register({ id: 'start-1', name: 'Start', port: 5003, command: 'node', args: ['app.js'] });
      await runtime.start('start-1');
      expect(mockSpawn).toHaveBeenCalledWith('node', ['app.js'], expect.any(Object));
      const state = runtime.getState('start-1');
      expect(state?.state).toBe('RUNNING');
      expect(state?.pid).toBe(12345);
    });

    it('should ignore start if already running', async () => {
      runtime.register({ id: 'running', name: 'Running', port: 5004, command: 'node' });
      await runtime.start('running');
      mockSpawn.mockClear();
      await runtime.start('running');
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should throw for unknown agent', async () => {
      await expect(runtime.start('unknown')).rejects.toThrow('not registered');
    });
  });

  describe('stop', () => {
    it('should stop running agent within timeout', async () => {
      runtime.register({ id: 'stop-1', name: 'Stop', port: 5005, command: 'node' });
      await runtime.start('stop-1');

      // Simulate process exit when killed
      mockProc.once.mockImplementation((_event: string, cb: () => void) => {
        setTimeout(cb, 10);
        return mockProc;
      });

      const start = Date.now();
      await runtime.stop('stop-1');
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1000); // should resolve quickly
      const state = runtime.getState('stop-1');
      expect(state?.state).toBe('STOPPED');
    });

    it('should handle already stopped agent', async () => {
      runtime.register({ id: 'stopped', name: 'Stopped', port: 5006, command: 'node' });
      // Not started, process is null
      await runtime.stop('stopped');
      const state = runtime.getState('stopped');
      expect(state?.state).toBe('STOPPED');
    });
  });

  describe('restart and backoff', () => {
    it('should restart with backoff delay', async () => {
      runtime.register({
        id: 'restart-1',
        name: 'Restart',
        port: 5007,
        command: 'node',
        autoRestart: true,
        maxRestarts: 3,
        restartBackoffMs: 50,
      });
      await runtime.start('restart-1');

      mockProc.once.mockImplementation((_event: string, cb: () => void) => {
        setTimeout(cb, 5);
        return mockProc;
      });

      const start = Date.now();
      await runtime.restart('restart-1');
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45); // allow some margin
      expect(runtime.getState('restart-1')?.restartCount).toBe(1);
    });

    it('should fail after max restarts', async () => {
      runtime.register({
        id: 'max-restart',
        name: 'MaxRestart',
        port: 5008,
        command: 'node',
        autoRestart: true,
        maxRestarts: 1,
        restartBackoffMs: 10,
      });
      await runtime.start('max-restart');

      mockProc.once.mockImplementation((_event: string, cb: () => void) => {
        setTimeout(cb, 2);
        return mockProc;
      });

      await runtime.restart('max-restart');
      expect(runtime.getState('max-restart')?.restartCount).toBe(1);

      await runtime.restart('max-restart');
      const state = runtime.getState('max-restart');
      expect(state?.state).toBe('FAILED');
    });
  });

 describe('health check', () => {
    it('should use injected health checker (healthy)', { timeout: 10000 }, async () => {
      checker.healthy = true;
      runtime.register({ id: 'hc-ok', name: 'HC OK', port: 5009, command: 'node', healthCheckIntervalMs: 50 });
      await runtime.start('hc-ok');

      // Wait for health check to run
      await new Promise((resolve) => setTimeout(resolve, 100));
      
      const state = runtime.getState('hc-ok');
      expect(state?.lastHealthCheck).toBeGreaterThan(0);
    });

    it('should record failed health check', { timeout: 10000 }, async () => {
      checker.healthy = false;
      runtime.register({ id: 'hc-fail', name: 'HC Fail', port: 5010, command: 'node', healthCheckIntervalMs: 50 });
      await runtime.start('hc-fail');

      // Wait for health check to run
      await new Promise((resolve) => setTimeout(resolve, 100));

      const history = runtime.getHistory('hc-fail');
      expect(history.some((h) => h.event === 'health_check_failed')).toBe(true);
    });
  });

  describe('heartbeat', () => {
    it('should update heartbeat timestamp', () => {
      runtime.register({ id: 'hb', name: 'Heartbeat', port: 5011, command: 'node' });
      runtime.updateHeartbeat('hb');
      const state = runtime.getState('hb');
      expect(state?.lastHeartbeat).toBeGreaterThan(0);
    });
  });

  describe('history', () => {
    it('should record start and stop events', async () => {
      runtime.register({ id: 'hist-1', name: 'Hist', port: 5012, command: 'node' });
      await runtime.start('hist-1');

      mockProc.once.mockImplementation((_event: string, cb: () => void) => {
        setTimeout(cb, 5);
        return mockProc;
      });

      await runtime.stop('hist-1');

      const hist = runtime.getHistory('hist-1');
      expect(hist.some((h) => h.event === 'register')).toBe(true);
      expect(hist.some((h) => h.event === 'start')).toBe(true);
      expect(hist.some((h) => h.event === 'stop')).toBe(true);
    });

    it('should filter history by agentId', () => {
      runtime.register({ id: 'a1', name: 'A1', port: 5013, command: 'node' });
      runtime.register({ id: 'a2', name: 'A2', port: 5014, command: 'node' });

      const all = runtime.getHistory();
      const a1 = runtime.getHistory('a1');

      expect(a1.every((h) => h.agentId === 'a1')).toBe(true);
      expect(all.length).toBeGreaterThan(a1.length);
    });
  });

  describe('bulk operations', () => {
    it('should stop all agents', async () => {
      runtime.register({ id: 'b1', name: 'B1', port: 5015, command: 'node' });
      runtime.register({ id: 'b2', name: 'B2', port: 5016, command: 'node' });
      await runtime.start('b1');
      await runtime.start('b2');

      mockProc.once.mockImplementation((_event: string, cb: () => void) => {
        setTimeout(cb, 2);
        return mockProc;
      });

      await runtime.stopAll();

      expect(runtime.getState('b1')?.state).toBe('STOPPED');
      expect(runtime.getState('b2')?.state).toBe('STOPPED');
    });

    it('should return all agent states', () => {
      runtime.register({ id: 'all-1', name: 'All1', port: 5017, command: 'node' });
      runtime.register({ id: 'all-2', name: 'All2', port: 5018, command: 'node' });

      const states = runtime.getAllStates();
      expect(states.size).toBe(2);
    });
  });
});
