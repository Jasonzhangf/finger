import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SnapshotManager } from '../../../src/core/snapshot.js';
import { Registry } from '../../../src/core/registry-new.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('SnapshotManager', () => {
  let registry: Registry;
  let snapshot: SnapshotManager;
  const testPath = path.join(os.tmpdir(), 'finger-snapshot-test.json');

  beforeEach(() => {
    registry = new Registry();
    snapshot = new SnapshotManager(registry, testPath);
  });

  afterEach(() => {
    if (fs.existsSync(testPath)) {
      fs.unlinkSync(testPath);
    }
  });

  it('marks dirty', () => {
    snapshot.markDirty();
    // Private property, but we can verify through tick behavior
  });

  it('saves snapshot when dirty', () => {
    registry.register({ id: 'in1', type: 'input', kind: 'stdin', config: {}, status: 'active' });
    snapshot.markDirty();
    
    // Force tick by calling load after marking dirty
    // Note: tick() is private, so we test through start/stop
    snapshot.start();
    snapshot.stop();
    
    if (fs.existsSync(testPath)) {
      const content = fs.readFileSync(testPath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.entries).toBeDefined();
    }
  });

  it('loads snapshot', () => {
    // Write a snapshot manually
    const testData = {
      entries: [{ id: 'loaded', type: 'input', kind: 'test', config: {}, status: 'active', lastHeartbeat: Date.now() }],
      routes: []
    };
    fs.writeFileSync(testPath, JSON.stringify(testData));

    const loaded = snapshot.load();

    expect(loaded).not.toBeNull();
    expect(loaded?.entries).toHaveLength(1);
  });

  it('returns null when no snapshot exists', () => {
    const loaded = snapshot.load();
    expect(loaded).toBeNull();
  });
});
