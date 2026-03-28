import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ensureFingerLayout, getFingerPaths } from '../../../src/core/finger-paths.js';

describe('HeartbeatScheduler loadConfig', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'finger-heartbeat-test-'));
    process.env.FINGER_HOME = tempDir;
    ensureFingerLayout();
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env.FINGER_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns ok:false when config JSON is invalid', async () => {
    const configPath = path.join(getFingerPaths(tempDir).runtime.schedulesDir, 'heartbeat-config.jsonl');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, '{ invalid json', 'utf-8');

    // Dynamically import to pick up FINGER_HOME override
    const mod = await import('../../../src/server/modules/heartbeat-scheduler.js');
    const { HeartbeatScheduler } = mod;
    const scheduler = new HeartbeatScheduler({} as any);

    // @ts-expect-error - private method for testing
    const result = await scheduler.loadConfig();
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns ok:true and default config when config file missing', async () => {
    const mod = await import('../../../src/server/modules/heartbeat-scheduler.js');
    const { HeartbeatScheduler } = mod;
    const scheduler = new HeartbeatScheduler({} as any);

    // @ts-expect-error - private method for testing
    const result = await scheduler.loadConfig();
    expect(result.ok).toBe(true);
    expect(result.config).toBeDefined();
    expect(result.created).toBe(true);
  });
});
