import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrchestrationDaemon } from '../../../src/orchestration/daemon.js';
import { FINGER_PATHS } from '../../../src/core/finger-paths.js';
import type { ChildProcess } from 'child_process';

process.env.NODE_ENV = 'test';

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  openSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(),
}));

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('fs', () => fsMocks);
vi.mock('child_process', () => childProcessMocks);

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
  let mockChildProcess: ChildProcess;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    mockChildProcess = {
      pid: 12345,
      unref: vi.fn(),
    } as unknown as ChildProcess;

    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.readFileSync.mockReturnValue('');
    fsMocks.openSync.mockReturnValue(1);
    fsMocks.readdirSync.mockReturnValue([]);

    childProcessMocks.execSync.mockImplementation(() => {
      throw new Error('not running');
    });
    childProcessMocks.spawn.mockReturnValue(mockChildProcess);

    vi.spyOn(process, 'kill').mockImplementation(() => true as never);

    daemon = new OrchestrationDaemon();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default config', () => {
      expect(daemon).toBeDefined();
    });

    it('should accept custom config', () => {
      const customDaemon = new OrchestrationDaemon({
        port: 6000,
        host: '0.0.0.0',
      });
      expect(customDaemon).toBeDefined();
    });

    it('should create fingerDir if not exists', () => {
      expect(fsMocks.mkdirSync).toHaveBeenCalledWith(FINGER_PATHS.runtime.dir, { recursive: true });
      expect(fsMocks.mkdirSync).toHaveBeenCalledWith(FINGER_PATHS.logs.dir, { recursive: true });
      expect(fsMocks.mkdirSync).toHaveBeenCalledWith(FINGER_PATHS.runtime.autostartDir, { recursive: true });
    });
  });

  describe('start', () => {
    it('should not start if already running', async () => {
      fsMocks.existsSync.mockImplementation((path: string) =>
        path === FINGER_PATHS.runtime.autostartDir ||
        path === FINGER_PATHS.runtime.dir ||
        path === FINGER_PATHS.logs.dir ||
        path === '/fake/path/server.js'
      );
      daemon = new OrchestrationDaemon({
        serverScript: '/fake/path/server.js',
      });
      await daemon.start();
      await daemon.start();
      expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1);
    });

    it('should not start if server script not found', async () => {
      fsMocks.existsSync.mockReturnValue(false);
      daemon = new OrchestrationDaemon({ serverScript: '/fake/path/server.js' });
      await daemon.start();
      expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    });

    it('should start daemon successfully', async () => {
      fsMocks.existsSync.mockImplementation((path: string) => path === '/fake/path/server.js');
      daemon = new OrchestrationDaemon({ serverScript: '/fake/path/server.js' });
      await daemon.start();
      expect(childProcessMocks.spawn).toHaveBeenCalled();
      expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
        FINGER_PATHS.runtime.daemonPid,
        mockChildProcess.pid?.toString() || '',
      );
    });
  });

  describe('stop', () => {
    it('should do nothing if no PID file', async () => {
      fsMocks.existsSync.mockReturnValue(false);
      await daemon.stop();
      expect(fsMocks.unlinkSync).not.toHaveBeenCalled();
    });

    it('should stop daemon successfully', async () => {
      fsMocks.existsSync.mockImplementation((path: string) => path === FINGER_PATHS.runtime.daemonPid);
      fsMocks.readFileSync.mockReturnValue('12345');
      await daemon.stop();
      expect(process.kill).toHaveBeenCalled();
      expect(fsMocks.unlinkSync).toHaveBeenCalledWith(FINGER_PATHS.runtime.daemonPid);
    });

    it('should handle invalid PID on stop', async () => {
      fsMocks.existsSync.mockImplementation((path: string) => path === FINGER_PATHS.runtime.daemonPid);
      fsMocks.readFileSync.mockReturnValue('invalid');
      await daemon.stop();
      expect(fsMocks.unlinkSync).toHaveBeenCalledWith(FINGER_PATHS.runtime.daemonPid);
    });
  });

  describe('restart', () => {
    it('should stop then start', async () => {
      fsMocks.existsSync.mockImplementation((path: string) => path === '/fake/path/server.js');
      daemon = new OrchestrationDaemon({
        serverScript: '/fake/path/server.js'
      });
      const stopSpy = vi.spyOn(daemon, 'stop');
      const startSpy = vi.spyOn(daemon, 'start');
      await daemon.restart();
      expect(stopSpy).toHaveBeenCalled();
      expect(startSpy).toHaveBeenCalled();
    });
  });
});
