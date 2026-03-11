import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

// Reset modules before each test to clear cache
vi.mock('../../../../../src/tools/internal/memory/embedding-adapter.js', () => ({
  getEmbeddingAdapter: () => ({
    embed: async () => ({
      embedding: new Array(768).fill(0.1),
      tokens: 10,
    }),
  }),
}));

vi.mock('../../../../../src/tools/internal/memory/milvus-adapter.js', () => ({
  getMilvusAdapter: () => ({
    insert: async () => {},
    search: async () => [],
    delete: async () => {},
    close: async () => {},
  }),
  resetMilvusAdapter: vi.fn(),
}));

vi.mock('../../../../../src/tools/internal/memory/memory-config.js', () => ({
  loadMemoryConfig: () => ({
    embedding: { provider: 'local', baseUrl: 'http://localhost:1234/v1', model: 'test' },
    vectorStore: { type: 'milvus-lite' },
    compact: { threshold: 100, keepRecent: 50 },
  }),
  resetMemoryConfigCache: vi.fn(),
}));

import { memoryTool } from '../../../../../src/tools/internal/memory/memory-tool.js';

async function createUniqueTempDir(): Promise<string> {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const tempDir = path.join(os.tmpdir(), `memory-test-${timestamp}-${random}`);
  await fs.mkdir(tempDir, { recursive: true });
  return tempDir;
}

describe('MemoryTool', () => {
  describe('insert', () => {
    it('should insert a new memory entry', async () => {
      const projectPath = await createUniqueTempDir();
      const result = await memoryTool.execute({
        action: 'insert',
        project_path: projectPath,
        content: 'Test memory content',
        title: 'Test Title',
        type: 'fact',
        tags: ['test', 'memory'],
      });

      expect(result.ok).toBe(true);
      expect(result.action).toBe('insert');
      expect(result.entry).toBeDefined();
      expect(result.entry?.title).toBe('Test Title');
      expect(result.entry?.content).toBe('Test memory content');
      expect(result.entry?.type).toBe('fact');
      expect(result.entry?.tags).toEqual(['test', 'memory']);
      expect(result.entry?.id).toMatch(/^mem-/);

      await fs.rm(projectPath, { recursive: true, force: true });
    });

    it('should require content', async () => {
      const projectPath = await createUniqueTempDir();
      const result = await memoryTool.execute({
        action: 'insert',
        project_path: projectPath,
        title: 'Test Title',
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe('content is required');

      await fs.rm(projectPath, { recursive: true, force: true });
    });
  });

  describe('search', () => {
    it('should search entries by query', async () => {
      const projectPath = await createUniqueTempDir();
      
      await memoryTool.execute({
        action: 'insert',
        project_path: projectPath,
        content: 'Apple is a fruit',
        title: 'Apple',
      });
      await memoryTool.execute({
        action: 'insert',
        project_path: projectPath,
        content: 'Banana is yellow',
        title: 'Banana',
      });

      const result = await memoryTool.execute({
        action: 'search',
        project_path: projectPath,
        query: 'Apple',
      });

      expect(result.ok).toBe(true);
      expect(result.entries).toHaveLength(1);
      expect(result.entries?.[0]?.title).toBe('Apple');

      await fs.rm(projectPath, { recursive: true, force: true });
    });

    it('should require query for search', async () => {
      const projectPath = await createUniqueTempDir();
      
      await memoryTool.execute({
        action: 'insert',
        project_path: projectPath,
        content: 'Test entry',
      });

      const result = await memoryTool.execute({
        action: 'search',
        project_path: projectPath,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe('query is required');

      await fs.rm(projectPath, { recursive: true, force: true });
    });
  });

  describe('list', () => {
    it('should list all entries', async () => {
      const projectPath = await createUniqueTempDir();
      
      await memoryTool.execute({
        action: 'insert',
        project_path: projectPath,
        content: 'Entry 1',
      });
      await memoryTool.execute({
        action: 'insert',
        project_path: projectPath,
        content: 'Entry 2',
      });

      const result = await memoryTool.execute({
        action: 'list',
        project_path: projectPath,
      });

      expect(result.ok).toBe(true);
      expect(result.entries).toHaveLength(2);

      await fs.rm(projectPath, { recursive: true, force: true });
    });

    it('should filter by type', async () => {
      const projectPath = await createUniqueTempDir();
      
      await memoryTool.execute({
        action: 'insert',
        project_path: projectPath,
        content: 'Fact entry',
        type: 'fact',
      });
      await memoryTool.execute({
        action: 'insert',
        project_path: projectPath,
        content: 'Decision entry',
        type: 'decision',
      });

      const result = await memoryTool.execute({
        action: 'list',
        project_path: projectPath,
        type_filter: 'fact',
      });

      expect(result.ok).toBe(true);
      expect(result.entries).toHaveLength(1);
      expect(result.entries?.[0]?.type).toBe('fact');

      await fs.rm(projectPath, { recursive: true, force: true });
    });
  });

  describe('edit', () => {
    it('should edit an existing entry', async () => {
      const projectPath = await createUniqueTempDir();
      
      const inserted = await memoryTool.execute({
        action: 'insert',
        project_path: projectPath,
        content: 'Original content',
      });

      expect(inserted.ok).toBe(true);
      expect(inserted.entry?.id).toBeDefined();

      const result = await memoryTool.execute({
        action: 'edit',
        project_path: projectPath,
        entry_id: inserted.entry?.id,
        updates: { content: 'Updated content' },
      });

      expect(result.ok).toBe(true);
      expect(result.entry?.content).toBe('Updated content');

      await fs.rm(projectPath, { recursive: true, force: true });
    });

    it('should require entry_id for edit', async () => {
      const projectPath = await createUniqueTempDir();
      
      await memoryTool.execute({
        action: 'insert',
        project_path: projectPath,
        content: 'Test',
      });

      const result = await memoryTool.execute({
        action: 'edit',
        project_path: projectPath,
        updates: { content: 'Updated' },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe('entry_id is required');

      await fs.rm(projectPath, { recursive: true, force: true });
    });
  });

  describe('delete', () => {
    it('should delete an existing entry', async () => {
      const projectPath = await createUniqueTempDir();
      
      const inserted = await memoryTool.execute({
        action: 'insert',
        project_path: projectPath,
        content: 'To be deleted',
      });

      const result = await memoryTool.execute({
        action: 'delete',
        project_path: projectPath,
        entry_id: inserted.entry?.id,
      });

      expect(result.ok).toBe(true);
      expect(result.entry?.content).toBe('To be deleted');

      const list = await memoryTool.execute({
        action: 'list',
        project_path: projectPath,
      });
      expect(list.entries).toHaveLength(0);

      await fs.rm(projectPath, { recursive: true, force: true });
    });
  });

  describe('system scope permissions', () => {
    it('should allow system agent to edit system memory', async () => {
      const projectPath = await createUniqueTempDir();
      
      const inserted = await memoryTool.execute({
        action: 'insert',
        scope: 'system',
        project_path: projectPath,
        content: 'System entry',
      });

      expect(inserted.ok).toBe(true);

      const result = await memoryTool.execute({
        action: 'edit',
        scope: 'system',
        project_path: projectPath,
        entry_id: inserted.entry?.id,
        updates: { content: 'Updated' },
        caller_agent_id: 'finger-system-agent',
      });

      expect(result.ok).toBe(true);

      await fs.rm(projectPath, { recursive: true, force: true });
    });

    it('should block non-system agent from editing system memory', async () => {
      const projectPath = await createUniqueTempDir();
      
      const inserted = await memoryTool.execute({
        action: 'insert',
        scope: 'system',
        project_path: projectPath,
        content: 'System entry',
      });

      const result = await memoryTool.execute({
        action: 'edit',
        scope: 'system',
        project_path: projectPath,
        entry_id: inserted.entry?.id,
        updates: { content: 'Updated' },
        caller_agent_id: 'other-agent',
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Only system agent can edit system memory');

      await fs.rm(projectPath, { recursive: true, force: true });
    });
  });
});
