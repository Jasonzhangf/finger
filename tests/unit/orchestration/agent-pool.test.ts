import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { AgentPool } from '../../../src/orchestration/agent-pool.js';
import { lifecycleManager } from '../../../src/agents/core/agent-lifecycle.js';

vi.mock('fs', () => {
  const fsMock = {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
  return {
    default: fsMock,
    ...fsMock,
  };
});

vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/home/tester'),
  },
  homedir: vi.fn(() => '/home/tester'),
}));

vi.mock('../../../src/agents/core/agent-lifecycle.js', () => ({
  lifecycleManager: {
    killProcess: vi.fn(),
  },
}));

const HOME = '/home/tester/.finger';
const CONFIG_DIR = `${HOME}/config`;
const CONFIG = `${CONFIG_DIR}/agents.json`;
const AGENT_DIR = `${HOME}/runtime/agents`;

const fileSet = new Set<string>();
const fileContents = new Map<string, string>();

beforeEach(() => {
  vi.clearAllMocks();
  fileSet.clear();
  fileContents.clear();

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
});

describe('AgentPool', () => {
  it('initializes default agent config when file is missing', () => {
    const pool = new AgentPool();
    const agents = pool.getAllInstances();

    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe('executor-default');
    expect(fileSet.has(CONFIG_DIR)).toBe(true);
    expect(fileSet.has(AGENT_DIR)).toBe(true);
    expect(fileSet.has(CONFIG)).toBe(true);
  });

  it('loads configured agents from file', () => {
    fileSet.add(CONFIG);
    fileContents.set(CONFIG, JSON.stringify({
      agents: [{ id: 'custom-a', name: 'Custom A', mode: 'manual', port: 9200, autoStart: false }],
    }));

    const pool = new AgentPool();
    const agents = pool.getAllInstances();

    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe('custom-a');
    expect(agents[0].status).toBe('stopped');
  });

  it('spawnAgent starts an existing stopped agent', async () => {
    const pool = new AgentPool();
    const instance = await pool.spawnAgent('executor-default');

    expect(instance.status).toBe('running');
    expect(pool.getInstanceById('executor-default')?.status).toBe('running');
  });

  it('spawnAgent creates and starts a new agent when missing', async () => {
    const pool = new AgentPool();
    const instance = await pool.spawnAgent('executor-extra');

    expect(instance.id).toBe('executor-extra');
    expect(instance.status).toBe('running');
    expect(instance.config.port).toBeGreaterThanOrEqual(9100);
  });

  it('killInstance marks instance stopped and delegates lifecycle cleanup', () => {
    const pool = new AgentPool();
    const instance = pool.getInstanceById('executor-default');
    expect(instance).toBeDefined();
    if (!instance) return;

    instance.status = 'running';
    const child = { kill: vi.fn() } as unknown as NodeJS.Process;
    (instance as unknown as { process: NodeJS.Process | null }).process = child;

    const killed = pool.killInstance('executor-default');
    expect(killed).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(instance.status).toBe('stopped');
    expect(vi.mocked(lifecycleManager.killProcess)).toHaveBeenCalledWith('executor-default', 'stopped');
  });

  it('stopAll only stops running instances', async () => {
    const pool = new AgentPool();
    const runner = pool.getInstanceById('executor-default');
    if (!runner) return;
    runner.status = 'running';
    const killSpy = vi.spyOn(pool, 'killInstance');

    await pool.stopAll();

    expect(killSpy).toHaveBeenCalledWith('executor-default');
  });
});
