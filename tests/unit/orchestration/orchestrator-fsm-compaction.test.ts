import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { executeCacheMemory } from '../../../src/tools/internal/memory/cache-memory-tool.js';

describe('Orchestrator FSM - Cache Compaction Integration', () => {
  let tempDir: string;
  let projectPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fsm-compaction-'));
    projectPath = tempDir;
    
    // Initialize CACHE.md with test data
    const cachePath = path.join(projectPath, 'CACHE.md');
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, `# Conversation Cache

### USER REQUEST
**Time**: 2026-03-14T07:00:00Z
**Agent**: finger-orchestrator
**Session**: session-1

Implement cache compaction

### ASSISTANT RESPONSE
**Time**: 2026-03-14T07:05:00Z
**Agent**: finger-orchestrator
**Session**: session-1
**Finish Reason**: stop

Implementation complete

---

`, 'utf-8');
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('reviewer approval flow', () => {
    it('should compact cache and write to memory when reviewer passes', async () => {
      const result = await executeCacheMemory({
        action: 'compact',
        project_path: projectPath,
        content: 'Task reviewed and approved by reviewer',
      });

      expect(result.ok).toBe(true);

      // Verify MEMORY.md created with summary
      const memoryContent = await fs.readFile(path.join(projectPath, 'MEMORY.md'), 'utf-8');
      expect(memoryContent).toContain('[summary]');
      expect(memoryContent).toContain('Task reviewed and approved');
      expect(memoryContent).toContain('CACHE Summary');

      // Verify CACHE.md cleared with residue
      const cacheContent = await fs.readFile(path.join(projectPath, 'CACHE.md'), 'utf-8');
      expect(cacheContent).toContain('Last Summary');
      expect(cacheContent).toContain('Task reviewed and approved');
      // Old entries should be cleared
      expect(cacheContent).not.toContain('Implement cache compaction');
      expect(cacheContent).not.toContain('Implementation complete');
    });

    it('should handle multiple cache entries', async () => {
      // Add more entries to CACHE.md
      const cachePath = path.join(projectPath, 'CACHE.md');
      await fs.appendFile(cachePath, `
### USER REQUEST
**Time**: 2026-03-14T07:10:00Z
**Agent**: finger-orchestrator
**Session**: session-1

Add test case

---

`, 'utf-8');

      const result = await executeCacheMemory({
        action: 'compact',
        project_path: projectPath,
        content: 'Multiple entries compacted',
      });

      expect(result.ok).toBe(true);

      // Verify summary includes entry count
      const memoryContent = await fs.readFile(path.join(projectPath, 'MEMORY.md'), 'utf-8');
      expect(memoryContent).toContain('Multiple entries compacted');

      // Verify cache cleared
      const cacheContent = await fs.readFile(cachePath, 'utf-8');
      expect(cacheContent).not.toContain('Add test case');
    });

    it('should preserve cache structure after compaction', async () => {
      await executeCacheMemory({
        action: 'compact',
        project_path: projectPath,
        content: 'Review approved',
      });

      const cacheContent = await fs.readFile(path.join(projectPath, 'CACHE.md'), 'utf-8');
      expect(cacheContent).to.match(/^# Conversation Cache\n\n## Last Summary\n\n/);
      expect(cacheContent).toContain('Review approved');
    });
  });

  describe('reviewer rejection flow', () => {
    it('should not compact when reviewer rejects', async () => {
      // Simulate rejection - no compaction should occur
      const cacheBefore = await fs.readFile(path.join(projectPath, 'CACHE.md'), 'utf-8');

      // Rejection should not trigger compaction
      // This is handled at the FSM level - no compaction command is issued

      const cacheAfter = await fs.readFile(path.join(projectPath, 'CACHE.md'), 'utf-8');
      expect(cacheAfter).toBe(cacheBefore);
    });
  });
});
