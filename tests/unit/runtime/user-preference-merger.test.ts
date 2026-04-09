import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  extractUserPreferencePatches,
  mergeUserPreferences,
  readUserMd,
  writeUserMdWithHistory,
} from '../../../src/runtime/user-preference-merger.js';
import { resolveCompactMemoryPath } from '../../../src/runtime/context-ledger-memory-helpers.js';

describe('user-preference-merger', () => {
  let tmpDir: string;
  let userMdPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-upm-test-'));
    userMdPath = path.join(tmpDir, 'USER.md');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('extractUserPreferencePatches', () => {
    it('should extract patches from compact-memory.jsonl', async () => {
      const compactPath = resolveCompactMemoryPath(tmpDir, 'test-session-merge', 'test-agent', 'main');
      fs.mkdirSync(path.dirname(compactPath), { recursive: true });
      fs.appendFileSync(compactPath, JSON.stringify({
        id: 'compact-rust-only-1',
        timestamp_ms: Date.now(),
        timestamp_iso: new Date().toISOString(),
        event_type: 'compact_block',
        payload: {
          summary: 'Test summary',
          user_preference_patch: '用户偏好：简洁回复',
        },
      }) + '\n');

      // Extract patches
      const patches = await extractUserPreferencePatches(tmpDir, 'test-session-merge', 'test-agent', 'main');
      expect(patches).toHaveLength(1);
      expect(patches[0]).toBe('用户偏好：简洁回复');
    });

    it('should return empty array when no patches exist', async () => {
      const patches = await extractUserPreferencePatches(tmpDir, 'nonexistent', 'test-agent', 'main');
      expect(patches).toEqual([]);
    });

    it('should skip entries with empty patches', async () => {
      // Create compact file with empty patch
      const compactPath = resolveCompactMemoryPath(tmpDir, 'test-session-merge', 'test-agent', 'main');
      fs.mkdirSync(path.dirname(compactPath), { recursive: true });
      fs.appendFileSync(compactPath, JSON.stringify({
        id: 'compact-1',
        timestamp_ms: Date.now(),
        timestamp_iso: new Date().toISOString(),
        event_type: 'compact_block',
        payload: {
          summary: 'Test',
          user_preference_patch: '',
        },
      }) + '\n');
      fs.appendFileSync(compactPath, JSON.stringify({
        id: 'compact-2',
        timestamp_ms: Date.now(),
        timestamp_iso: new Date().toISOString(),
        event_type: 'compact_block',
        payload: {
          summary: 'Test2',
          user_preference_patch: '  ',
        },
      }) + '\n');

      const patches = await extractUserPreferencePatches(tmpDir, 'test-session-merge', 'test-agent', 'main');
      expect(patches).toEqual([]);
    });

    it('should extract multiple patches in order', async () => {
      const compactPath = resolveCompactMemoryPath(tmpDir, 'test-session-merge', 'test-agent', 'main');
      fs.mkdirSync(path.dirname(compactPath), { recursive: true });

      const patches_data = ['Patch 1', 'Patch 2', 'Patch 3'];
      for (const patch of patches_data) {
        fs.appendFileSync(compactPath, JSON.stringify({
          id: `compact-${Date.now()}`,
          timestamp_ms: Date.now(),
          timestamp_iso: new Date().toISOString(),
          event_type: 'compact_block',
          payload: {
            summary: 'Test',
            user_preference_patch: patch,
          },
        }) + '\n');
      }

      const patches = await extractUserPreferencePatches(tmpDir, 'test-session-merge', 'test-agent', 'main');
      expect(patches).toEqual(patches_data);
    });
  });

  describe('mergeUserPreferences', () => {
    it('should not modify USER.md when no patches', async () => {
      fs.writeFileSync(userMdPath, '# User\n\nExisting content');
      const result = await mergeUserPreferences(userMdPath, [], { rootDir: tmpDir });
      expect(result.modified).toBe(false);
      expect(result.patchCount).toBe(0);
      expect(fs.readFileSync(userMdPath, 'utf-8')).toBe('# User\n\nExisting content');
    });

    it('should append patches to USER.md', async () => {
      fs.writeFileSync(userMdPath, '# User\n\nExisting content');
      const result = await mergeUserPreferences(userMdPath, ['喜欢简洁回复', '偏好中文回答'], { rootDir: tmpDir });
      expect(result.modified).toBe(true);
      expect(result.patchCount).toBe(2);
      const content = fs.readFileSync(userMdPath, 'utf-8');
      expect(content).toContain('Existing content');
      expect(content).toContain('喜欢简洁回复');
      expect(content).toContain('偏好中文回答');
      expect(content).toContain('Preferences Update');
    });

    it('should filter empty patches', async () => {
      fs.writeFileSync(userMdPath, '# User');
      const result = await mergeUserPreferences(userMdPath, ['', '  ', 'Valid patch'], { rootDir: tmpDir });
      expect(result.modified).toBe(true);
      expect(result.patchCount).toBe(1);
    });

    it('should use custom merger when provided', async () => {
      fs.writeFileSync(userMdPath, '# User\n\nContent: ');
      const customMerger = async (current: string, patches: string[]) => {
        return current + patches.join('; ');
      };
      const result = await mergeUserPreferences(userMdPath, ['A', 'B'], {
        rootDir: tmpDir,
        merger: customMerger,
      });
      expect(result.modified).toBe(true);
      expect(fs.readFileSync(userMdPath, 'utf-8')).toBe('# User\n\nContent: A; B');
    });

    it('should backup USER.md to history before modifying', async () => {
      fs.writeFileSync(userMdPath, '# User\n\nOriginal content');
      const result = await mergeUserPreferences(userMdPath, ['New preference'], { rootDir: tmpDir });
      expect(result.modified).toBe(true);

      // Check history was created
      const historyDir = path.join(tmpDir, 'user-preference-history');
      expect(fs.existsSync(historyDir)).toBe(true);
      const historyFiles = fs.readdirSync(historyDir).filter(f => f.startsWith('USER-'));
      expect(historyFiles.length).toBe(1);

      const historyContent = fs.readFileSync(path.join(historyDir, historyFiles[0]), 'utf-8');
      expect(historyContent).toBe('# User\n\nOriginal content');
    });
  });

  describe('readUserMd', () => {
    it('should read file content', async () => {
      fs.writeFileSync(userMdPath, 'Test content');
      expect(await readUserMd(userMdPath)).toBe('Test content');
    });

    it('should return empty string for missing file', async () => {
      expect(await readUserMd(path.join(tmpDir, 'nonexistent.md'))).toBe('');
    });
  });

  describe('writeUserMdWithHistory', () => {
    it('should write file and create history backup', async () => {
      fs.writeFileSync(userMdPath, 'Original');
      await writeUserMdWithHistory(userMdPath, 'Updated', path.join(tmpDir, 'history'));
      expect(fs.readFileSync(userMdPath, 'utf-8')).toBe('Updated');

      const historyDir = path.join(tmpDir, 'history');
      expect(fs.existsSync(historyDir)).toBe(true);
      const historyFiles = fs.readdirSync(historyDir);
      expect(historyFiles.length).toBe(1);
      expect(fs.readFileSync(path.join(historyDir, historyFiles[0]), 'utf-8')).toBe('Original');
    });

    it('should create directory if not exists', async () => {
      const newPath = path.join(tmpDir, 'subdir', 'USER.md');
      await writeUserMdWithHistory(newPath, 'Content');
      expect(fs.existsSync(newPath)).toBe(true);
      expect(fs.readFileSync(newPath, 'utf-8')).toBe('Content');
    });
  });
});
