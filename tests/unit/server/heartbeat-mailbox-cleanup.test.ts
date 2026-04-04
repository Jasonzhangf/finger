import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { FINGER_PATHS } from '../../../src/core/finger-paths.js';
import { heartbeatMailbox } from '../../../src/server/modules/heartbeat-mailbox.js';

describe('heartbeat mailbox cleanup', () => {
  it('removes mailbox file and empty target dir after removeAll', () => {
    const target = `test-mailbox-cleanup-${Date.now()}`;
    const targetDir = path.join(FINGER_PATHS.home, 'mailbox', target);
    fs.rmSync(targetDir, { recursive: true, force: true });

    heartbeatMailbox.append(target, { text: 'cleanup' }, { sender: 'test' });
    expect(fs.existsSync(path.join(targetDir, 'inbox.jsonl'))).toBe(true);

    const removed = heartbeatMailbox.removeAll(target);
    expect(removed.removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(targetDir, 'inbox.jsonl'))).toBe(false);
    expect(fs.existsSync(targetDir)).toBe(false);
  });
});
