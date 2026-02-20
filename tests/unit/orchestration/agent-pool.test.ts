import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentPool, AgentInstanceConfig } from '../../../src/orchestration/agent-pool.js';

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    openSync: vi.fn(() => 1),
    unlinkSync: vi.fn(),
  },
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  openSync: vi.fn(() => 1),
  unlinkSync: vi.fn(),
}));

// Mock os module
vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/home/test'),
  },
  homedir: vi.fn(() => '/home/test'),
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    unref: vi.fn(),
    on: vi.fn(),
  })),
}));

// Mock lifecycle manager
vi.mock('../../../src/agents/core/agent-lifecycle.js', () => ({
  lifecycleManager: {
    registerProcess: vi.fn(),
    killProcess: vi.fn(),
  },
}));

// Mock fetch for health checks
global.fetch = vi.fn();

describe('AgentPool', () => {
  let pool: AgentPool;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = new AgentPool();
  });

  describe('constructor', () => {
    it('should initialize with default agents', () => {
      const configs = pool.getConfigs();
      expect(configs.length).toBeGreaterThan(0);
    });

    it('should have executor-default in configs', () => {
      const configs = pool.getConfigs();
      expect(configs.some(c => c.id === 'executor-default')).toBe(true);
    });
  });

  describe('getConfigs', () => {
    it('should return copy of configs', () => {
      const configs1 = pool.getConfigs();
      const configs2 = pool.getConfigs();
      expect(configs1).not.toBe(configs2);
      expect(configs1).toEqual(configs2);
    });
  });

  describe('addAgent', () => {
    it('should add new agent config', () => {
      const config: AgentInstanceConfig = {
        id: 'test-agent',
        name: 'Test Agent',
        mode: 'manual',
        port: 9200,
      };
      
      pool.addAgent(config);
      
      const configs = pool.getConfigs();
      expect(configs.some(c => c.id === 'test-agent')).toBe(true);
    });

    it('should throw for duplicate id', () => {
      const config: AgentInstanceConfig = {
        id: 'executor-default',
        name: 'Duplicate',
        mode: 'manual',
        port: 9200,
      };
      
      expect(() => pool.addAgent(config)).toThrow('already exists');
    });
  });

  describe('removeAgent', () => {
    it('should throw for non-existent agent', async () => {
      await expect(pool.removeAgent('nonexistent')).rejects.toThrow('not found');
    });

    it('should remove existing agent', async () => {
      const config: AgentInstanceConfig = {
        id: 'removable',
        name: 'Removable',
        mode: 'manual',
        port: 9201,
      };
      pool.addAgent(config);
      
      await pool.removeAgent('removable');
      
      const configs = pool.getConfigs();
      expect(configs.some(c => c.id === 'removable')).toBe(false);
    });
  });

  describe('getAgentStatus', () => {
    it('should return status for existing agent', () => {
      const status = pool.getAgentStatus('executor-default');
      expect(status).toBeDefined();
      expect(status!.config.id).toBe('executor-default');
    });

    it('should return undefined for non-existent', () => {
      const status = pool.getAgentStatus('nonexistent');
      expect(status).toBeUndefined();
    });
  });

  describe('listAgents', () => {
    it('should return all agents', () => {
      const agents = pool.listAgents();
      expect(agents.length).toBeGreaterThan(0);
    });

    it('should include new agents', () => {
      const config: AgentInstanceConfig = {
        id: 'new-agent',
        name: 'New Agent',
        mode: 'manual',
        port: 9202,
      };
      pool.addAgent(config);
      
      const agents = pool.listAgents();
      expect(agents.some(a => a.config.id === 'new-agent')).toBe(true);
    });
  });

  describe('startAgent', () => {
    it('should throw for non-existent agent', async () => {
      await expect(pool.startAgent('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('stopAgent', () => {
    it('should throw for non-existent agent', async () => {
      await expect(pool.stopAgent('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('restartAgent', () => {
    it('should throw for non-existent agent', async () => {
      await expect(pool.restartAgent('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('startAllAuto', () => {
    it('should complete without error', async () => {
      // Mock fetch to resolve immediately (health check passes)
      (global.fetch as any).mockResolvedValue({ ok: true });
      // Mock fs to return false (no PID file, agent not running)
      const fsMock = await import('fs');
      (fsMock.existsSync as any).mockReturnValue(false);
      
      await pool.startAllAuto();
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe('stopAll', () => {
    it('should complete without error', async () => {
      const fsMock = await import('fs');
      (fsMock.existsSync as any).mockReturnValue(false);
      
      await pool.stopAll();
      // Should complete without error
    });
  });
});
