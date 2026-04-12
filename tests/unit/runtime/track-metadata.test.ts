import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  allocateTrack,
  allocateTrackSync,
  readTracksMetadata,
  readTracksMetadataSync,
  writeTracksMetadata,
  updateTrackMetadata,
  getAvailableTracks,
  getTracksFilePath,
  generatePreview,
} from '../../../src/runtime/track-metadata.js';

describe('track-metadata', () => {
  const tmpDir = path.join(os.tmpdir(), `finger-track-test-${Date.now()}`);
  const testProject = path.join(tmpDir, 'test-project');
  let originalHome: string | undefined;

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.mkdir(testProject, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    // Ensure clean state
    const tracksFile = getTracksFilePath(testProject);
    await fs.rm(path.dirname(tracksFile), { recursive: true, force: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('getTracksFilePath', () => {
    it('returns a deterministic path based on project path hash', () => {
      const p1 = getTracksFilePath('/some/project');
      const p2 = getTracksFilePath('/some/project');
      expect(p1).toBe(p2);
    });

    it('returns different paths for different project paths', () => {
      const p1 = getTracksFilePath('/project-a');
      const p2 = getTracksFilePath('/project-b');
      expect(p1).not.toBe(p2);
    });
  });

  describe('readTracksMetadata', () => {
    it('returns empty object when no tracks file exists', async () => {
      const result = await readTracksMetadata(testProject);
      expect(result).toEqual({});
    });

    it('reads existing tracks file', async () => {
      const tracksFile = getTracksFilePath(testProject);
      await fs.mkdir(path.dirname(tracksFile), { recursive: true });
      await fs.writeFile(tracksFile, JSON.stringify({ track0: { lastActiveAt: '2024-01-01T00:00:00Z', preview: 'hello' } }));

      const result = await readTracksMetadata(testProject);
      expect(result).toHaveProperty('track0');
      expect(result.track0.preview).toBe('hello');
    });
  });

  describe('readTracksMetadataSync', () => {
    it('returns empty object when no tracks file exists', () => {
      const result = readTracksMetadataSync(testProject);
      expect(result).toEqual({});
    });

    it('reads existing tracks file synchronously', () => {
      const tracksFile = getTracksFilePath(testProject);
      require('fs').mkdirSync(path.dirname(tracksFile), { recursive: true });
      require('fs').writeFileSync(tracksFile, JSON.stringify({ track0: { lastActiveAt: '2024-01-01T00:00:00Z', preview: 'test' } }));

      const result = readTracksMetadataSync(testProject);
      expect(result).toHaveProperty('track0');
    });
  });

  describe('writeTracksMetadata', () => {
    it('writes tracks file and can be read back', async () => {
      const tracks = { track0: { lastActiveAt: '2024-01-01', preview: 'test' } };
      await writeTracksMetadata(testProject, tracks);

      const read = await readTracksMetadata(testProject);
      expect(read).toHaveProperty('track0');
    });
  });

  describe('updateTrackMetadata', () => {
    it('creates new track entry', async () => {
      await updateTrackMetadata(testProject, 'track0', { preview: 'new track' });

      const tracks = await readTracksMetadata(testProject);
      expect(tracks.track0.preview).toBe('new track');
      expect(tracks.track0.lastActiveAt).toBeDefined();
    });

    it('updates existing track entry', async () => {
      await updateTrackMetadata(testProject, 'track0', { preview: 'first' });
      await updateTrackMetadata(testProject, 'track0', { preview: 'updated' });

      const tracks = await readTracksMetadata(testProject);
      expect(tracks.track0.preview).toBe('updated');
    });
  });

  describe('allocateTrack', () => {
    it('allocates track0 when no existing tracks', async () => {
      const result = await allocateTrack(testProject);
      expect(result).toBe('track0');
    });

    it('reuses track0 when it exists but is not active', async () => {
      await updateTrackMetadata(testProject, 'track0', { preview: 'exists' });
      // track0 exists in metadata but is NOT in activeTracks, so it gets reused
      const result = await allocateTrack(testProject);
      expect(result).toBe('track0');
    });

    it('allocates next track when all existing tracks are active', async () => {
      await updateTrackMetadata(testProject, 'track0', { preview: 'active' });
      const active = new Set(['track0']);
      const result = await allocateTrack(testProject, active);
      expect(result).toBe('track1');
    });

    it('reuses gaps in track numbering', async () => {
      await updateTrackMetadata(testProject, 'track0', { preview: 'active' });
      await updateTrackMetadata(testProject, 'track2', { preview: 'active' });

      const active = new Set(['track0', 'track2']);
      const result = await allocateTrack(testProject, active);
      expect(result).toBe('track1');
    });

    it('falls back to next number when all lower tracks are active', async () => {
      await updateTrackMetadata(testProject, 'track0', { preview: 'active' });
      const active = new Set(['track0']);
      const result = await allocateTrack(testProject, active);
      expect(result).toBe('track1');
    });
  });

  describe('allocateTrackSync', () => {
    it('allocates track0 when no existing tracks', () => {
      const result = allocateTrackSync(testProject);
      expect(result).toBe('track0');
    });

    it('allocates next available track synchronously', () => {
      const tracksFile = getTracksFilePath(testProject);
      require('fs').mkdirSync(path.dirname(tracksFile), { recursive: true });
      require('fs').writeFileSync(tracksFile, JSON.stringify({
        track0: { lastActiveAt: '2024-01-01', preview: 'active' },
        track1: { lastActiveAt: '2024-01-01', preview: 'active' },
      }));

      const active = new Set(['track0', 'track1']);
      const result = allocateTrackSync(testProject, active);
      expect(result).toBe('track2');
    });

    it('reuses gaps synchronously', () => {
      const tracksFile = getTracksFilePath(testProject);
      require('fs').mkdirSync(path.dirname(tracksFile), { recursive: true });
      require('fs').writeFileSync(tracksFile, JSON.stringify({
        track0: { lastActiveAt: '2024-01-01', preview: 'active' },
        track2: { lastActiveAt: '2024-01-01', preview: 'active' },
      }));

      const active = new Set(['track0', 'track2']);
      const result = allocateTrackSync(testProject, active);
      expect(result).toBe('track1');
    });
  });

  describe('getAvailableTracks', () => {
    it('returns tracks sorted by lastActiveAt descending', async () => {
      await updateTrackMetadata(testProject, 'track0', { lastActiveAt: '2024-01-01T00:00:00Z', preview: 'old' });
      await updateTrackMetadata(testProject, 'track1', { lastActiveAt: '2024-06-01T00:00:00Z', preview: 'new' });

      const tracks = await getAvailableTracks(testProject);
      expect(tracks[0].id).toBe('track1');
      expect(tracks[1].id).toBe('track0');
    });

    it('returns empty array when no tracks', async () => {
      const tracks = await getAvailableTracks(testProject);
      expect(tracks).toEqual([]);
    });
  });

  describe('generatePreview', () => {
    it('trims whitespace', () => {
      expect(generatePreview('  hello world  ')).toBe('hello world');
    });

    it('collapses multiple spaces', () => {
      expect(generatePreview('hello   world')).toBe('hello world');
    });

    it('truncates long content', () => {
      const long = 'a'.repeat(150);
      const result = generatePreview(long);
      expect(result.length).toBe(100);
      expect(result.endsWith('...')).toBe(true);
    });

    it('keeps short content as-is', () => {
      expect(generatePreview('short')).toBe('short');
    });
  });
});
