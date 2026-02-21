import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { spawn } from 'child_process';
import { AgentPool } from '../../../src/orchestration/agent-pool.js';
import { lifecycleManager } from '../../../src/agents/core/agent-lifecycle.js';

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    openSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/home/tester'),
  },
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../../src/agents/core/agent-lifecycle.js', () => ({
  lifecycleManager: {
    registerProcess: vi.fn(),
    killProcess: vi.fn(),
  },
}));

type ExitHandler = (code: number | null, signal: string | null) => void;
type ErrorHandler = (error: Error) => void;

type ChildStub = {
  pid?: number;
  unref: ReturnType<typeof vi.fn>;
  on: (event: 'exit' | 'error', handler: ExitHandler | ErrorHandler) => void;
};

const HOME = '/home/tester/.finger';
const CONFIG = `${HOME}/agents.json`;
const AGENT_DIR = `${HOME}/agents`;
const DEFAULT_PID = `${AGENT_DIR}/executor-default.pid`;

const fileSet = new Set<string>();
const fileContents = new Map<string, string>();
const runningPids = new Set<number>();

let exitHandlers: ExitHandler[] = [];
let errorHandlers: ErrorHandler[] = [];

function mockChild(pid?: number): ChildStub {
  exitHandlers = [];
  errorHandlers = [];
  return {
    pid,
    unref: vi.fn(),
    on: (event, handler) => {
      if (event === 'exit') {
        exitHandlers.push(handler as ExitHandler);
      } else {
        errorHandlers.push(handler as ErrorHandler);
      }
    },
  };
}

function setPidFile(path: string, pidText: string): void {
  fileSet.add(path);
  fileContents.set(path, pidText);
}

beforeEach(() => {
  vi.clearAllMocks();
  fileSet.clear();
  fileContents.clear();
  runningPids.clear();
  exitHandlers = [];
  errorHandlers = [];

  vi.mocked(fs.existsSync).mockImplementation((target) => fileSet.has(String(target)));
  vi.mocked(fs.mkdirSync).mockImplementation((target) => {
    fileSet.add(String(target));
    return undefined;
  });
  vi.mocked(fs.readFileSync).mockImplementation((target) => {
    const key = String(target);
    const content = fileContents.get(key);
    if (content === undefined) {
      throw new Error(`ENOENT: ${key}`);
    }
    return content;
  });
  vi.mocked(fs.writeFileSync).mockImplementation((target, data) => {
    const key = String(target);
    fileSet.add(key);
    fileContents.set(key, String(data));
    return undefined;
  });
  vi.mocked(fs.openSync).mockReturnValue(101);
  vi.mocked(fs.unlinkSync).mockImplementation((target) => {
    const key = String(target);
    fileSet.delete(key);
    fileContents.delete(key);
    return undefined;
  });

  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
    if (signal === 0) {
      if (runningPids.has(Number(pid))) {
        return true;
      }
      throw new Error('ESRCH');
    }
    return true;
  }) as typeof process.kill);

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  vi.mocked(spawn).mockReturnValue(mockChild(12345) as never);
});

describe('AgentPool', () => {
  it('initializes defaults and writes config when missing', () => {
    const pool = new AgentPool();

    expect(pool.getConfigs()).toHaveLength(1);
    expect(pool.getConfigs()[0].id).toBe('executor-default');
    expect(fileSet.has(HOME)).toBe(true);
    expect(fileSet.has(AGENT_DIR)).toBe(true);
    expect(fileSet.has(CONFIG)).toBe(true);
  });

  it('loads config from file when present', () => {
    const custom = {
      agents: [{ id: 'custom-a', name: 'Custom A', mode: 'manual', port: 9200, autoStart: false }],
    };
    setPidFile(CONFIG, JSON.stringify(custom));

    const pool = new AgentPool();

    expect(pool.getConfigs()).toHaveLength(1);
    expect(pool.getConfigs()[0].id).toBe('custom-a');
  });

  it('falls back to default config when config parsing fails', () => {
    setPidFile(CONFIG, '{bad json');

    const pool = new AgentPool();

    expect(pool.getConfigs().some((item) => item.id === 'executor-default')).toBe(true);
    expect(fileContents.get(CONFIG)?.includes('executor-default')).toBe(true);
  });

  it('adds and removes agent config', async () => {
    const pool = new AgentPool();
    pool.addAgent({ id: 'added', name: 'Added', mode: 'manual', port: 9201 });

    expect(pool.getConfigs().some((item) => item.id === 'added')).toBe(true);

    await pool.removeAgent('added');
    expect(pool.getConfigs().some((item) => item.id === 'added')).toBe(false);
  });

  it('throws when adding duplicate agent id', () => {
    const pool = new AgentPool();

    expect(() =>
      pool.addAgent({ id: 'executor-default', name: 'dup', mode: 'manual', port: 9300 }),
    ).toThrow('already exists');
  });

  it('refreshes status to stopped when pid file is missing', () => {
    const pool = new AgentPool();

    const status = pool.getAgentStatus('executor-default');

    expect(status?.status).toBe('stopped');
    expect(status?.pid).toBeUndefined();
  });

  it('refreshes status to stopped and unlinks when pid is invalid', () => {
    const pool = new AgentPool();
    setPidFile(DEFAULT_PID, 'not-a-number');

    const status = pool.getAgentStatus('executor-default');

    expect(status?.status).toBe('stopped');
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith(DEFAULT_PID);
  });

  it('refreshes status to running when pid is alive', () => {
    const pool = new AgentPool();
    setPidFile(DEFAULT_PID, '23456');
    runningPids.add(23456);

    const status = pool.getAgentStatus('executor-default');

    expect(status?.status).toBe('running');
    expect(status?.pid).toBe(23456);
  });

  it('refreshes status to stopped and cleans stale pid', () => {
    const pool = new AgentPool();
    setPidFile(DEFAULT_PID, '34567');

    const status = pool.getAgentStatus('executor-default');

    expect(status?.status).toBe('stopped');
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith(DEFAULT_PID);
  });

  it('starts agent successfully with healthy check', async () => {
    const pool = new AgentPool();
    runningPids.add(12345);

    await pool.startAgent('executor-default');

    const status = pool.getAgentStatus('executor-default');
    expect(status?.status).toBe('running');
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(lifecycleManager.registerProcess)).toHaveBeenCalledTimes(1);
    expect(fileSet.has(DEFAULT_PID)).toBe(true);
  });

  it('returns early when startAgent sees running pid', async () => {
    const pool = new AgentPool();
    setPidFile(DEFAULT_PID, '8888');
    runningPids.add(8888);

    await pool.startAgent('executor-default');

    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it('fails startAgent when spawn has no pid', async () => {
    const pool = new AgentPool();
    vi.mocked(spawn).mockReturnValueOnce(mockChild(undefined) as never);

    await expect(pool.startAgent('executor-default')).rejects.toThrow('Failed to spawn');

    const state = pool.getAgentStatus('executor-default');
    expect(state?.status).toBe('stopped');
  });

  it('fails startAgent when health check times out', async () => {
    const pool = new AgentPool();
    vi.spyOn(pool as unknown as { waitForHealth: (port: number, timeoutMs?: number) => Promise<boolean> }, 'waitForHealth')
      .mockResolvedValue(false);

    await expect(pool.startAgent('executor-default')).rejects.toThrow('health check failed');

    const state = pool.getAgentStatus('executor-default');
    expect(state?.status).toBe('stopped');
  });

  it('registers child exit/error handlers and updates state', async () => {
    const pool = new AgentPool();
    runningPids.add(12345);
    await pool.startAgent('executor-default');

    expect(exitHandlers).toHaveLength(1);
    expect(errorHandlers).toHaveLength(1);

    exitHandlers[0](0, null);
    expect((pool as unknown as { agents: Map<string, { status: string }> }).agents.get('executor-default')?.status).toBe('stopped');

    errorHandlers[0](new Error('child-failure'));
    const internal = (pool as unknown as { agents: Map<string, { status: string; lastError?: string }> }).agents.get('executor-default');
    expect(internal?.status).toBe('error');
    expect(internal?.lastError).toBe('child-failure');
  });

  it('stops agent when pid file exists and valid', async () => {
    const pool = new AgentPool();
    setPidFile(DEFAULT_PID, '12345');

    await pool.stopAgent('executor-default');

    expect(vi.mocked(lifecycleManager.killProcess)).toHaveBeenCalledWith('agent-executor-default', 'user-request');
    expect(fileSet.has(DEFAULT_PID)).toBe(false);
  });

  it('stops agent with invalid pid file content', async () => {
    const pool = new AgentPool();
    setPidFile(DEFAULT_PID, 'bad-pid');

    await pool.stopAgent('executor-default');

    expect(fileSet.has(DEFAULT_PID)).toBe(false);
    expect(vi.mocked(lifecycleManager.killProcess)).not.toHaveBeenCalled();
  });

  it('returns early when stopAgent sees no pid file', async () => {
    const pool = new AgentPool();

    await pool.stopAgent('executor-default');

    expect(vi.mocked(lifecycleManager.killProcess)).not.toHaveBeenCalled();
  });

  it('restarts agent by calling stop then start', async () => {
    const pool = new AgentPool();
    const stopSpy = vi.spyOn(pool, 'stopAgent').mockResolvedValue();
    const startSpy = vi.spyOn(pool, 'startAgent').mockResolvedValue();

    await pool.restartAgent('executor-default');

    expect(stopSpy).toHaveBeenCalledWith('executor-default');
    expect(startSpy).toHaveBeenCalledWith('executor-default');
  });

  it('startAllAuto catches start errors', async () => {
    const pool = new AgentPool();
    vi.spyOn(pool, 'startAgent').mockRejectedValue(new Error('boom'));

    await expect(pool.startAllAuto()).resolves.toBeUndefined();
  });

  it('stopAll catches stop errors', async () => {
    const pool = new AgentPool();
    const listSpy = vi.spyOn(pool, 'listAgents').mockReturnValue([
      {
        config: { id: 'a1', name: 'A1', mode: 'auto', port: 9102, autoStart: true },
        process: null,
        status: 'running',
      },
      {
        config: { id: 'a2', name: 'A2', mode: 'auto', port: 9103, autoStart: true },
        process: null,
        status: 'running',
      },
    ]);
    const stopSpy = vi.spyOn(pool, 'stopAgent')
      .mockRejectedValueOnce(new Error('stop-failed'))
      .mockResolvedValueOnce(undefined);

    await expect(pool.stopAll()).resolves.toBeUndefined();
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledTimes(2);
  });

  it('waitForHealth returns false when retries fail', async () => {
    const pool = new AgentPool();
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('down'));

    const result = await (pool as unknown as { waitForHealth: (port: number, timeoutMs?: number) => Promise<boolean> })
      .waitForHealth(9900, 5);

    expect(result).toBe(false);
  });
});
