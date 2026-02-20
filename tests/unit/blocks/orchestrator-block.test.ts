import { describe, it, expect, beforeEach } from 'vitest';
import { OrchestratorBlock } from '../../../src/blocks/orchestrator-block/index.js';

describe('OrchestratorBlock', () => {
  let block: OrchestratorBlock;

  beforeEach(() => {
    block = new OrchestratorBlock('test-orchestrator');
  });

  describe('constructor', () => {
    it('should initialize with id and type', () => {
      expect(block.id).toBe('test-orchestrator');
      expect(block.type).toBe('orchestrator');
    });

    it('should have all required capabilities', () => {
      const caps = block.capabilities;
      expect(caps.functions).toContain('start');
      expect(caps.functions).toContain('pause');
      expect(caps.functions).toContain('resume');
      expect(caps.functions).toContain('status');
      expect(caps.functions).toContain('decompose');
      expect(caps.functions).toContain('schedule');
    });
  });

  describe('execute - start', () => {
    it('should start orchestrator', async () => {
      const result = await block.execute('start', {});
      expect(result.started).toBe(true);
    });
  });

  describe('execute - status', () => {
    it('should return running status', async () => {
      await block.execute('start', {});
      const status = await block.execute('status', {});
      expect(status.running).toBe(true);
      expect(Array.isArray(status.activeProjects)).toBe(true);
    });

    it('should return not running initially', async () => {
      const status = await block.execute('status', {});
      expect(status.running).toBe(false);
    });
  });

  describe('execute - pause', () => {
    it('should pause orchestrator', async () => {
      await block.execute('start', {});
      const result = await block.execute('pause', {});
      expect(result.paused).toBe(true);
      const status = await block.execute('status', {});
      expect(status.running).toBe(false);
    });
  });

  describe('execute - resume', () => {
    it('should resume orchestrator', async () => {
      await block.execute('start', {});
      await block.execute('pause', {});
      const result = await block.execute('resume', {});
      expect(result.resumed).toBe(true);
      const status = await block.execute('status', {});
      expect(status.running).toBe(true);
    });
  });

  describe('execute - decompose', () => {
    it('should decompose task for project', async () => {
      const result = await block.execute('decompose', { projectId: 'proj-1', task: 'test task' });
      expect(result.decomposed).toBe(true);
      expect(result.projectId).toBe('proj-1');
    });

    it('should track active projects', async () => {
      await block.execute('decompose', { projectId: 'proj-1', task: 'test' });
      const status = await block.execute('status', {});
      expect(status.activeProjects.length).toBe(1);
    });
  });

  describe('execute - schedule', () => {
    it('should return scheduled false when not running', async () => {
      const result = await block.execute('schedule', { projectId: 'proj-1' });
      expect(result.scheduled).toBe(false);
    });

    it('should return scheduled true when running', async () => {
      await block.execute('start', {});
      const result = await block.execute('schedule', { projectId: 'proj-1' });
      expect(result.scheduled).toBe(true);
    });
  });

  describe('execute - unknown command', () => {
    it('should throw for unknown command', async () => {
      await expect(block.execute('unknown', {})).rejects.toThrow('Unknown command');
    });
  });
});
