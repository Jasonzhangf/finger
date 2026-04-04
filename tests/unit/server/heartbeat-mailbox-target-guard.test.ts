import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FINGER_PATHS } from '../../../src/core/finger-paths.js';
import { heartbeatMailbox } from '../../../src/server/modules/heartbeat-mailbox.js';

const cleanupDirs = new Set<string>();

afterEach(() => {
  for (const target of cleanupDirs) {
    fs.rmSync(path.join(FINGER_PATHS.home, 'mailbox', target), { recursive: true, force: true });
  }
  cleanupDirs.clear();
});

describe('heartbeat mailbox target guard', () => {
  it('rejects synthetic test namespace target in non-test runtime', () => {
    const prevVitest = process.env.VITEST;
    const prevNodeEnv = process.env.NODE_ENV;
    const prevWorker = process.env.VITEST_WORKER_ID;
    try {
      delete process.env.VITEST;
      delete process.env.VITEST_WORKER_ID;
      process.env.NODE_ENV = 'production';

      expect(() => heartbeatMailbox.append('agent-progress-123', { text: 'x' })).toThrow(
        'synthetic test namespace',
      );
    } finally {
      if (typeof prevVitest === 'undefined') delete process.env.VITEST;
      else process.env.VITEST = prevVitest;
      if (typeof prevNodeEnv === 'undefined') delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (typeof prevWorker === 'undefined') delete process.env.VITEST_WORKER_ID;
      else process.env.VITEST_WORKER_ID = prevWorker;
    }
  });

  it('allows valid runtime target and persists inbox', () => {
    const target = `test-mailbox-guard-${Date.now()}`;
    cleanupDirs.add(target);
    const appended = heartbeatMailbox.append(target, { text: 'ok' }, { sender: 'test' });
    const msg = heartbeatMailbox.get(target, appended.id);
    expect(msg?.id).toBe(appended.id);
  });
});
