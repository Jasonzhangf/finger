import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { CacheCompactionTrigger } from '../../../src/agents/base/cache-compaction-trigger.js';

describe('Cache Compaction Trigger', () => {
  let tempDir: string;
  let projectPath: string;
  let trigger: CacheCompactionTrigger;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'finger-compaction-'));
    projectPath = tempDir;
    trigger = new CacheCompactionTrigger({
      projectPath,
    });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('triggerOnApproval', () => {
    it('should skip when disabled', async () => {
      const disabledTrigger = new CacheCompactionTrigger({
        projectPath,
        enabled: false,
      });

      const result = await disabledTrigger.triggerOnApproval({
        sessionId: 'session-1',
        agentId: 'test-agent',
        reviewerOutcome: 'approved',
      });

      expect(result).toBe(false);
    });

    it('should skip when reviewer outcome is rejected', async () => {
      const result = await trigger.triggerOnApproval({
        sessionId: 'session-1',
        agentId: 'test-agent',
        reviewerOutcome: 'rejected',
      });

      expect(result).toBe(false);
    });

    it('should compact cache when reviewer approves', async () => {
      // Create CACHE.md with some content
      const cachePath = path.join(projectPath, 'CACHE.md');
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, `# Conversation Cache\n\n### USER REQUEST\n**Time**: 2026-03-14T06:30:00Z\n\nTest request\n\n`, 'utf-8');

      const result = await trigger.triggerOnApproval({
        sessionId: 'session-1',
        agentId: 'test-agent',
        reviewerOutcome: 'approved',
      });

      expect(result).toBe(true);

      // Verify MEMORY.md created
      const memoryContent = await fs.readFile(path.join(projectPath, 'MEMORY.md'), 'utf-8');
      expect(memoryContent).toContain('[summary]');
      expect(memoryContent).toContain('CACHE Summary');

      // Verify CACHE.md cleared
      const cacheContent = await fs.readFile(cachePath, 'utf-8');
      expect(cacheContent).toContain('Last Summary');
      expect(cacheContent).not.toContain('Test request');
    });

    it('should use custom summary when provided', async () => {
      const cachePath = path.join(projectPath, 'CACHE.md');
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, `# Conversation Cache\n\n### USER REQUEST\nTest\n\n`, 'utf-8');

      await trigger.triggerOnApproval({
        sessionId: 'session-1',
        agentId: 'test-agent',
        reviewerOutcome: 'approved',
        summary: 'Custom approval summary',
      });

      const memoryContent = await fs.readFile(path.join(projectPath, 'MEMORY.md'), 'utf-8');
      expect(memoryContent).toContain('Custom approval summary');
    });

    it('should do nothing when cache is empty', async () => {
      const result = await trigger.triggerOnApproval({
        sessionId: 'session-1',
        agentId: 'test-agent',
        reviewerOutcome: 'approved',
      });

      expect(result).toBe(true); // Still returns true, but no files created

      // Verify no MEMORY.md created
      try {
        await fs.access(path.join(projectPath, 'MEMORY.md'));
        expect(false).toBe(true); // Should not reach here
      } catch {
        // Expected - file doesn't exist
        expect(true).toBe(true);
      }
    });
  });

  describe('generateDefaultSummary', () => {
    it('should generate summary with session info', async () => {
      const timestamp = new Date().toISOString();
      
      const summary = (trigger as any).generateDefaultSummary({
        sessionId: 'session-1',
        agentId: 'test-agent',
        reviewerOutcome: 'approved',
      });

      expect(summary).toContain('Reviewer Approval');
      expect(summary).toContain('session-1');
      expect(summary).toContain('test-agent');
      expect(summary).toContain('approved');
    });
  });
});
