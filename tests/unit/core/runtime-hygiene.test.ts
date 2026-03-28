import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  pruneOrphanSessionRootDirs,
  sanitizeRuntimePidFiles,
  type PidFileDescriptor,
} from '../../../src/core/runtime-hygiene.js';

describe('runtime hygiene', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    while (cleanupPaths.length > 0) {
      const target = cleanupPaths.pop();
      if (target) rmSync(target, { recursive: true, force: true });
    }
  });

  it('removes stale pid files when pid is not alive', () => {
    const root = mkdtempSync(join(tmpdir(), 'finger-runtime-hygiene-'));
    cleanupPaths.push(root);
    const pidFile = join(root, 'server.pid');
    writeFileSync(pidFile, '999999', 'utf8');

    const descriptors: PidFileDescriptor[] = [
      {
        filePath: pidFile,
        tag: 'server.pid',
        matchers: ['/Volumes/extension/code/finger', 'dist/server/index.js'],
      },
    ];

    const result = sanitizeRuntimePidFiles(descriptors, []);
    expect(result.removed).toEqual(['server.pid']);
  });


  it('keeps live pid files when cmdline matches current project entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'finger-runtime-hygiene-'));
    cleanupPaths.push(root);
    const pidFile = join(root, 'server.pid');
    writeFileSync(pidFile, '30318', 'utf8');

    const descriptors: PidFileDescriptor[] = [
      {
        filePath: pidFile,
        tag: 'server.pid',
        matchers: ['/Volumes/extension/code/finger', 'dist/server/index.js'],
      },
    ];

    const result = sanitizeRuntimePidFiles(descriptors, [
      {
        pid: 30318,
        command: 'node /Volumes/extension/code/finger/dist/server/index.js',
      },
    ]);

    expect(result.removed).toEqual([]);
  });

  it('removes pid files when cmdline belongs to another project process', () => {
    const root = mkdtempSync(join(tmpdir(), 'finger-runtime-hygiene-'));
    cleanupPaths.push(root);
    const pidFile = join(root, 'server.pid');
    writeFileSync(pidFile, '30318', 'utf8');

    const descriptors: PidFileDescriptor[] = [
      {
        filePath: pidFile,
        tag: 'server.pid',
        matchers: ['/Volumes/extension/code/finger', 'dist/server/index.js'],
      },
    ];

    const result = sanitizeRuntimePidFiles(descriptors, [
      {
        pid: 30318,
        command: 'node /Volumes/extension/code/other-project/dist/server/index.js',
      },
    ]);

    expect(result.removed).toEqual(['server.pid']);
  });

  it('removes top-level orphan session roots without metadata json', () => {
    const root = mkdtempSync(join(tmpdir(), 'finger-session-hygiene-'));
    cleanupPaths.push(root);
    const orphan = join(root, 'session-123');
    mkdirSync(join(orphan, 'finger-system-agent', 'main'), { recursive: true });
    writeFileSync(join(orphan, 'finger-system-agent', 'main', 'context-ledger.jsonl'), 'orphan', 'utf8');

    const valid = join(root, 'session-456');
    mkdirSync(valid, { recursive: true });
    writeFileSync(join(valid, 'main.json'), '{"id":"session-456","projectPath":"/tmp/x"}', 'utf8');

    const result = pruneOrphanSessionRootDirs(root);
    expect(result.removed).toEqual([orphan]);
  });
});
