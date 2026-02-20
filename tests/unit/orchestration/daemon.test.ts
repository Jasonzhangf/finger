import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OrchestrationDaemon, ProcessAdapter, FsAdapter } from '../../../src/orchestration/daemon.js';
import type { ChildProcess } from 'child_process';

// Mock os module
vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/home/test'),
  },
  homedir: vi.fn(() => '/home/test'),
}));

// Mock AgentPool
vi.mock('../../../src/orchestration/agent-pool.js', () => ({
  AgentPool: vi.fn(() => ({
    startAllAuto: vi.fn(),
    stopAll: vi.fn(),
  })),
}));

// Mock HeartbeatBroker
vi.mock('../../../src/agents/core/agent-lifecycle.js', () => ({
  HeartbeatBroker: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
  lifecycleManager: {
    killProcess: vi.fn(),
    registerProcess: vi.fn(),
  },
  cleanupOrphanProcesses: vi.fn(() => ({ killed: [], errors: [] })),
}));

describe('OrchestrationDaemon', () => {
  let daemon: OrchestrationDaemon;
  let mockProcessAdapter: ProcessAdapter;
  let mockFsAdapter: FsAdapter;
  let mockChildProcess: ChildProcess;

  beforeEach(() => {
    vi.clearAllMocks();

    mockChildProcess = {
      pid: 12345,
      unref: vi.fn(),
      on: vi.fn(),
      kill: vi.fn(),
    } as unknown as ChildProcess;

    mockProcessAdapter = {
      spawn: vi.fn(() => mockChildProcess),
      isPidRunning: vi.fn(() => false),
      killProcess: vi.fn(),
      registerProcess: vi.fn(),
      cleanupOrphans: vi.fn(() => ({ killed: [], errors: [] })),
    };

    mockFsAdapter = {
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      writeFileSync: vi.fn(),
      openSync: vi.fn(() => 1),
      unlinkSync: vi.fn(),
    };

    daemon = new OrchestrationDaemon({}, mockProcessAdapter, mockFsAdapter);
  });

  describe('constructor', () => {
    it('should initialize with default config', () => {
      expect(daemon).toBeDefined();
      expect(daemon.getRunningState()).toBe(false);
    });

    it('should accept custom config', () => {
      const customDaemon = new OrchestrationDaemon({
        port: 6000,
        host: '0.0.0.0',
      }, mockProcessAdapter, mockFsAdapter);
      expect(customDaemon).toBeDefined();
    });

    it('should create fingerDir if not exists', () => {
      expect(mockFsAdapter.mkdirSync).toHaveBeenCalled();
    });
  });

  describe('isRunning', () => {
    it('should return false when no PID file', () => {
      (mockFsAdapter.existsSync as any).mockReturnValue(false);
      expect(daemon.isRunning()).toBe(false);
    });

    it('should return true when PID is running', () => {
      (mockFsAdapter.existsSync as any).mockReturnValue(true);
      (mockFsAdapter.readFileSync as any).mockReturnValue('12345');
      (mockProcessAdapter.isPidRunning as any).mockReturnValue(true);
      
      expect(daemon.isRunning()).toBe(true);
    });

    it('should return false and clean PID file when PID not running', () => {
      (mockFsAdapter.existsSync as any).mockReturnValue(true);
      (mockFsAdapter.readFileSync as any).mockReturnValue('12345');
      (mockProcessAdapter.isPidRunning as any).mockReturnValue(false);
      
      expect(daemon.isRunning()).toBe(false);
      expect(mockFsAdapter.unlinkSync).toHaveBeenCalled();
    });

    it('should handle invalid PID file', () => {
      (mockFsAdapter.existsSync as any).mockReturnValue(true);
      (mockFsAdapter.readFileSync as any).mockReturnValue('invalid');
      
      expect(daemon.isRunning()).toBe(false);
      expect(mockFsAdapter.unlinkSync).toHaveBeenCalled();
    });
  });

  describe('start', () => {
    it('should not start if already running', async () => {
      daemon.setRunningState(true);
      await daemon.start();
      expect(mockProcessAdapter.spawn).not.toHaveBeenCalled();
    });

    it('should not start if PID file exists and process running', async () => {
      (mockFsAdapter.existsSync as any).mockReturnValue(true);
      (mockFsAdapter.readFileSync as any).mockReturnValue('12345');
      (mockProcessAdapter.isPidRunning as any).mockReturnValue(true);
      
      await daemon.start();
      
      expect(daemon.getRunningState()).toBe(true);
      expect(mockProcessAdapter.spawn).not.toHaveBeenCalled();
    });

    it('should not start if server script not found', async () => {
      (mockFsAdapter.existsSync as any)
        .mockReturnValueOnce(true) // fingerDir exists
        .mockReturnValueOnce(false); // serverScript not found
      
      // Need to recreate daemon after setting up mock
      daemon = new OrchestrationDaemon({}, mockProcessAdapter, mockFsAdapter);
      
      await daemon.start();
      
      expect(mockProcessAdapter.spawn).not.toHaveBeenCalled();
    });

    it('should start daemon successfully', async () => {
      (mockFsAdapter.existsSync as any).mockReturnValue(true);
      (mockProcessAdapter.isPidRunning as any).mockReturnValue(false);
      
      // Need to recreate daemon to avoid constructor already checking exists
      daemon = new OrchestrationDaemon({
        serverScript: '/fake/path/server.js'
      }, mockProcessAdapter, mockFsAdapter);
      
      // Mock server script exists
      (mockFsAdapter.existsSync as any).mockReturnValue(true);
      
      await daemon.start();
      
      expect(mockProcessAdapter.spawn).toHaveBeenCalled();
      expect(mockProcessAdapter.registerProcess).toHaveBeenCalled();
      expect(mockFsAdapter.writeFileSync).toHaveBeenCalled();
      expect(daemon.getRunningState()).toBe(true);
    });

    it('should cleanup orphan processes on start', async () => {
      const killedOrphans = ['proc-1', 'proc-2'];
      (mockProcessAdapter.cleanupOrphans as any).mockReturnValue({
        killed: killedOrphans,
        errors: [],
      });
      (mockFsAdapter.existsSync as any).mockReturnValue(true);
      
      daemon = new OrchestrationDaemon({
        serverScript: '/fake/path/server.js'
      }, mockProcessAdapter, mockFsAdapter);
      
      await daemon.start();
      
      expect(mockProcessAdapter.cleanupOrphans).toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('should do nothing if no PID file', async () => {
      (mockFsAdapter.existsSync as any).mockReturnValue(false);
      
      await daemon.stop();
      
      expect(mockProcessAdapter.killProcess).not.toHaveBeenCalled();
    });

    it('should stop daemon successfully', async () => {
      (mockFsAdapter.existsSync as any).mockReturnValue(true);
      (mockFsAdapter.readFileSync as any).mockReturnValue('12345');
      
      await daemon.stop();
      
      expect(mockProcessAdapter.killProcess).toHaveBeenCalledWith('daemon-server', 'user-request');
      expect(mockFsAdapter.unlinkSync).toHaveBeenCalled();
      expect(daemon.getRunningState()).toBe(false);
    });

    it('should handle invalid PID on stop', async () => {
      (mockFsAdapter.existsSync as any).mockReturnValue(true);
      (mockFsAdapter.readFileSync as any).mockReturnValue('invalid');
      
      await daemon.stop();
      
      expect(mockFsAdapter.unlinkSync).toHaveBeenCalled();
      expect(mockProcessAdapter.killProcess).not.toHaveBeenCalled();
    });
  });

  describe('restart', () => {
    it('should stop then start', async () => {
      (mockFsAdapter.existsSync as any).mockReturnValue(true);
      (mockProcessAdapter.isPidRunning as any).mockReturnValue(false);
      
      daemon = new OrchestrationDaemon({
        serverScript: '/fake/path/server.js'
      }, mockProcessAdapter, mockFsAdapter);
      
      const stopSpy = vi.spyOn(daemon as any, 'stop');
      const startSpy = vi.spyOn(daemon as any, 'start');
      
      await daemon.restart();
      
      expect(stopSpy).toHaveBeenCalled();
      expect(startSpy).toHaveBeenCalled();
    });
  });

  describe('getAgentPool', () => {
    it('should return agent pool', () => {
      const pool = daemon.getAgentPool();
      expect(pool).toBeDefined();
    });
  });
});
