import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/agents/core/agent-lifecycle.js', () => ({
  lifecycleManager: {
    registerProcess: vi.fn(),
    updateActivity: vi.fn(),
    killProcess: vi.fn().mockReturnValue(true),
  },
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn((event, cb) => { if (event === 'data') cb(Buffer.from('output')); }) },
    stderr: { on: vi.fn((event, cb) => { if (event === 'data') cb(Buffer.from('')); }) },
    on: vi.fn((event, cb) => { if (event === 'close') setTimeout(() => cb(0), 10); }),
  })),
}));

import { AgentBlock } from '../../../src/blocks/agent-block/index.js';

describe('AgentBlock', () => {
  let block: AgentBlock;

  beforeEach(() => {
    vi.clearAllMocks();
    block = new AgentBlock('test-agent');
  });

  describe('constructor', () => {
    it('should initialize with id and type', () => {
      expect(block.id).toBe('test-agent');
      expect(block.type).toBe('agent');
    });

    it('should have all required capabilities', () => {
      const caps = block.capabilities;
      expect(caps.functions).toContain('spawn');
      expect(caps.functions).toContain('assign');
      expect(caps.functions).toContain('status');
      expect(caps.functions).toContain('kill');
      expect(caps.functions).toContain('list');
      expect(caps.functions).toContain('heartbeat');
    });
  });

  describe('execute - spawn', () => {
    it('should spawn an agent', async () => {
      const agent = await block.execute('spawn', {
        role: 'executor',
        sdk: 'iflow',
        capabilities: ['web_search'],
      });
      expect(agent.id).toBeDefined();
      expect(agent.role).toBe('executor');
      expect(agent.sdk).toBe('iflow');
      expect(agent.status).toBe('idle');
    });
  });

  describe('execute - list', () => {
    it('should list all agents', async () => {
      await block.execute('spawn', { role: 'executor', sdk: 'iflow' });
      await block.execute('spawn', { role: 'reviewer', sdk: 'codex' });
      const agents = await block.execute('list', {});
      expect(Array.isArray(agents)).toBe(true);
      expect(agents.length).toBe(2);
    });
  });

  describe('execute - status', () => {
    it('should return agent status', async () => {
      const agent: any = await block.execute('spawn', { role: 'executor', sdk: 'iflow' });
      const status = await block.execute('status', { agentId: agent.id });
      expect(status).toBeDefined();
      expect((status as any).id).toBe(agent.id);
    });

    it('should return undefined for non-existent agent', async () => {
      const status = await block.execute('status', { agentId: 'non-existent' });
      expect(status).toBeUndefined();
    });
  });

  describe('execute - heartbeat', () => {
    it('should update agent heartbeat', async () => {
      const agent: any = await block.execute('spawn', { role: 'executor', sdk: 'iflow' });
      const result = await block.execute('heartbeat', { agentId: agent.id });
      expect(result.alive).toBe(true);
    });

    it('should return false for non-existent agent', async () => {
      const result = await block.execute('heartbeat', { agentId: 'non-existent' });
      expect(result.alive).toBe(false);
    });
  });

  describe('execute - assign', () => {
    it('should assign task to agent', async () => {
      const agent: any = await block.execute('spawn', { role: 'executor', sdk: 'iflow' });
      const result = await block.execute('assign', {
        agentId: agent.id,
        taskId: 'task-1',
        prompt: 'test prompt',
      });
      expect(result).toBeDefined();
    });

    it('should throw for non-existent agent', async () => {
      await expect(block.execute('assign', {
        agentId: 'non-existent',
        taskId: 'task-1',
        prompt: 'test',
      })).rejects.toThrow('not found');
    });
  });

  describe('execute - kill', () => {
    it('should kill agent process', async () => {
      const agent: any = await block.execute('spawn', { role: 'executor', sdk: 'iflow' });
      const result = await block.execute('kill', { agentId: agent.id });
      expect(result.killed).toBe(true);
    });
  });

  describe('execute - unknown command', () => {
    it('should throw for unknown command', async () => {
      await expect(block.execute('unknown', {})).rejects.toThrow('Unknown command');
    });
  });
});
