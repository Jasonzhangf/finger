import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionControlPlaneStore } from '../../../src/runtime/session-control-plane.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('session-control-plane', () => {
  it('stores independent provider sessions per fingerSessionId + agentId', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-scp-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'session-control-plane.json');
    const store = new SessionControlPlaneStore(filePath);

    store.set('finger-1', 'orchestrator', 'iflow', 'iflow-session-orch');
    store.set('finger-1', 'reviewer', 'iflow', 'iflow-session-review');

    expect(store.get('finger-1', 'orchestrator', 'iflow')?.providerSessionId).toBe('iflow-session-orch');
    expect(store.get('finger-1', 'reviewer', 'iflow')?.providerSessionId).toBe('iflow-session-review');
    expect(store.list({ fingerSessionId: 'finger-1' })).toHaveLength(2);
  });

  it('removes only target scoped binding', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-scp-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'session-control-plane.json');
    const store = new SessionControlPlaneStore(filePath);

    store.set('finger-1', 'orchestrator', 'iflow', 'iflow-session-orch');
    store.set('finger-1', 'reviewer', 'iflow', 'iflow-session-review');

    expect(store.remove('finger-1', 'orchestrator', 'iflow')).toBe(true);
    expect(store.get('finger-1', 'orchestrator', 'iflow')).toBeNull();
    expect(store.get('finger-1', 'reviewer', 'iflow')?.providerSessionId).toBe('iflow-session-review');
  });

  it('reads legacy iflow map format and migrates in memory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-scp-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'legacy-iflow-map.json');

    writeFileSync(filePath, JSON.stringify({
      version: '1.0.0',
      bindings: {
        'finger-legacy': {
          fingerSessionId: 'finger-legacy',
          iflowSessionId: 'iflow-legacy',
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
      },
    }, null, 2), 'utf-8');

    const store = new SessionControlPlaneStore(filePath);
    const loaded = store.get('finger-legacy', 'iflow-default', 'iflow');

    expect(loaded).not.toBeNull();
    expect(loaded?.providerSessionId).toBe('iflow-legacy');
    expect(loaded?.agentId).toBe('iflow-default');
    expect(loaded?.provider).toBe('iflow');
  });
});

