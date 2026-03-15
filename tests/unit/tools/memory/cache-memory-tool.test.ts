import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { executeCacheMemory } from '../../../../src/tools/internal/memory/cache-memory-tool.js';

describe('Cache Memory Tool - CACHE.md Support', () => {
  let tempDir: string;
  let projectPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'finger-cache-memory-'));
    projectPath = tempDir;
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('insert to cache', () => {
    it('should create CACHE.md and write entry', async () => {
      const result = await executeCacheMemory({
        action: 'insert',
        project_path: projectPath,
        cache_entry: {
          timestamp: '2026-03-14T06:30:00Z',
          agent_id: 'test-agent',
          session_id: 'session-1',
          role: 'user',
          type: 'request',
          content: 'test request',
          summary: 'test',
        },
      });

      expect(result.ok).toBe(true);
      expect(result.cache_path).toBeDefined();

      const cacheContent = await fs.readFile(path.join(projectPath, 'CACHE.md'), 'utf-8');
      expect(cacheContent).toContain('USER REQUEST');
      expect(cacheContent).toContain('test request');
    });

    it('should append to existing CACHE.md', async () => {
      // First insert
      await executeCacheMemory({
        action: 'insert',
        project_path: projectPath,
        cache_entry: {
          timestamp: '2026-03-14T06:30:00Z',
          agent_id: 'test-agent',
          session_id: 'session-1',
          role: 'user',
          type: 'request',
          content: 'first request',
        },
      });

      // Second insert
      await executeCacheMemory({
        action: 'insert',
        project_path: projectPath,
        cache_entry: {
          timestamp: '2026-03-14T06:31:00Z',
          agent_id: 'test-agent',
          session_id: 'session-1',
          role: 'assistant',
          type: 'response',
          content: 'first response',
          finish_reason: 'stop',
        },
      });

      const cacheContent = await fs.readFile(path.join(projectPath, 'CACHE.md'), 'utf-8');
      expect(cacheContent).toContain('first request');
      expect(cacheContent).toContain('first response');
      expect(cacheContent).toContain('---');
    });
  });

  describe('compact cache to memory', () => {
    it('should create MEMORY.md with summary', async () => {
      // Insert some entries
      await executeCacheMemory({
        action: 'insert',
        project_path: projectPath,
        cache_entry: {
          timestamp: '2026-03-14T06:30:00Z',
          agent_id: 'test-agent',
          session_id: 'session-1',
          role: 'user',
          type: 'request',
          content: 'test request',
        },
      });

      // Compact
      const result = await executeCacheMemory({
        action: 'compact',
        project_path: projectPath,
        content: 'Custom summary',
      });

      expect(result.ok).toBe(true);
      expect(result.memory_path).toBeDefined();

      const memoryContent = await fs.readFile(path.join(projectPath, 'MEMORY.md'), 'utf-8');
      expect(memoryContent).toContain('Custom summary');
      expect(memoryContent).toContain('[summary]');
    });

    it('should clear CACHE.md and write summary residue', async () => {
      // Insert entries
      await executeCacheMemory({
        action: 'insert',
        project_path: projectPath,
        cache_entry: {
          timestamp: '2026-03-14T06:30:00Z',
          agent_id: 'test-agent',
          session_id: 'session-1',
          role: 'user',
          type: 'request',
          content: 'test request',
        },
      });

      // Compact
      await executeCacheMemory({
        action: 'compact',
        project_path: projectPath,
        content: 'Test summary',
      });

      const cacheContent = await fs.readFile(path.join(projectPath, 'CACHE.md'), 'utf-8');
      expect(cacheContent).toContain('Last Summary');
      expect(cacheContent).toContain('Test summary');
      // Should not contain old entries
      expect(cacheContent).not.toContain('test request');
    });

    it('should generate default summary when not provided', async () => {
      // Insert multiple entries
      await executeCacheMemory({
        action: 'insert',
        project_path: projectPath,
        cache_entry: {
          timestamp: '2026-03-14T06:30:00Z',
          agent_id: 'test-agent',
          session_id: 'session-1',
          role: 'user',
          type: 'request',
          content: 'request 1',
        },
      });

      await executeCacheMemory({
        action: 'insert',
        project_path: projectPath,
        cache_entry: {
          timestamp: '2026-03-14T06:31:00Z',
          agent_id: 'test-agent',
          session_id: 'session-1',
          role: 'assistant',
          type: 'response',
          content: 'response 1',
        },
      });

      // Compact without content
      const result = await executeCacheMemory({
        action: 'compact',
        project_path: projectPath,
      });

      expect(result.ok).toBe(true);
      expect(result.ok).toBe(true);
    });
  });

  describe('clear cache', () => {
    it('should clear all cache entries', async () => {
      // Insert entry
      await executeCacheMemory({
        action: 'insert',
        project_path: projectPath,
        cache_entry: {
          timestamp: '2026-03-14T06:30:00Z',
          agent_id: 'test-agent',
          session_id: 'session-1',
          role: 'user',
          type: 'request',
          content: 'test request',
        },
      });

      // Clear
      const result = await executeCacheMemory({
        action: 'clear',
        project_path: projectPath,
      });

      expect(result.ok).toBe(true);

      const cacheContent = await fs.readFile(path.join(projectPath, 'CACHE.md'), 'utf-8');
      expect(cacheContent).toBe('# Conversation Cache\n\n');
    });
  });
});
