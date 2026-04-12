import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { SessionManager } from '../../../src/orchestration/session-manager.js';
import { readTracksMetadata, getTracksFilePath } from '../../../src/runtime/track-metadata.js';

describe('session-manager multi-track', () => {
  const tmpDir = path.join(os.tmpdir(), `finger-sm-track-test-${Date.now()}`);
  let manager: SessionManager;

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    manager = new SessionManager({ sessionsRootDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('createSession with track allocation', () => {
    it('assigns track0 to first session', async () => {
      const session = await manager.createSession('/tmp/project-a', 'Test Project');
      expect(session.track).toBe('track0');
    });

    it('assigns track0 to sessions on different projects', async () => {
      const s1 = await manager.createSession('/tmp/project-a', 'Project A');
      const s2 = await manager.createSession('/tmp/project-b', 'Project B');
      expect(s1.track).toBe('track0');
      expect(s2.track).toBe('track0');
    });

    it('writes tracks.json after session creation', async () => {
      await manager.createSession('/tmp/project-a', 'Test Project');

      const tracksPath = getTracksFilePath('/tmp/project-a');
      const tracks = await readTracksMetadata('/tmp/project-a');
      expect(tracks).toHaveProperty('track0');
      expect(tracks.track0.preview).toBe('Test Project');
    });

    it('allocates track1 for second session on same project', async () => {
      const s1 = manager.createSession('/tmp/project-a', 'Session 1');
      expect(s1.track).toBe('track0');

      // Need allowReuse: false to create a new session (default is true which reuses existing)
      const s2 = manager.createSession('/tmp/project-a', 'Session 2', { allowReuse: false });
      expect(s2.id).not.toBe(s1.id);
      expect(s2.track).toBe('track1');
    });


  });

  describe('ensureSession with track allocation', () => {
    it('assigns track to new session via ensureSession', async () => {
      const session = manager.ensureSession('/tmp/project-a', 'test-session-ensure');
      expect(session.track).toBe('track0');
    });

    it('returns existing session with same track via ensureSession', async () => {
      const session1 = manager.ensureSession('/tmp/project-a', 'test-session-ensure');
      const track0 = session1.track;

      const session2 = manager.ensureSession('/tmp/project-a', 'test-session-ensure');
      expect(session2.id).toBe(session1.id);
      expect(session2.track).toBe(track0);
    });
  });
});
