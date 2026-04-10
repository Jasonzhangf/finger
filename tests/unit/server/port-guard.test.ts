import { describe, expect, it } from 'vitest';
import { __test__, isManagedFingerPortProcess } from '../../../src/server/modules/port-guard.js';

describe('port-guard', () => {
  it('recognizes managed finger server processes only', () => {
    expect(isManagedFingerPortProcess({
      pid: 100,
      ppid: 1,
      command: 'node /Volumes/extension/code/finger/dist/server/index.js',
    }, '/Volumes/extension/code/finger')).toBe(true);

    expect(isManagedFingerPortProcess({
      pid: 101,
      ppid: 1,
      command: 'node /Volumes/extension/code/other-project/dist/server/index.js',
    }, '/Volumes/extension/code/finger')).toBe(false);

    expect(isManagedFingerPortProcess({
      pid: 102,
      ppid: 1,
    }, '/Volumes/extension/code/finger')).toBe(false);

    expect(isManagedFingerPortProcess({
      pid: 103,
      ppid: 100,
      command: '/Volumes/extension/code/finger/dist/bin/finger-kernel-bridge-bin',
    }, '/Volumes/extension/code/finger')).toBe(true);

    expect(isManagedFingerPortProcess({
      pid: 104,
      ppid: 1,
      command: '/other/path/finger-kernel-bridge-bin',
    }, '/Volumes/extension/code/finger')).toBe(false);
  });

  it('collects descendants from explicit process tree only', () => {
    const map = __test__.buildChildrenMap([
      { pid: 10, ppid: 1, command: 'root' },
      { pid: 11, ppid: 10, command: 'child-a' },
      { pid: 12, ppid: 10, command: 'child-b' },
      { pid: 13, ppid: 11, command: 'grandchild' },
      { pid: 20, ppid: 1, command: 'other-root' },
    ]);

    expect(__test__.collectDescendants(10, map).sort((a, b) => a - b)).toEqual([11, 12, 13]);
    expect(__test__.collectDescendants(20, map)).toEqual([]);
  });

  it('resolves port owner pids from TCP LISTEN only to avoid false positives', () => {
    const command = __test__.buildLsofListenCommand(9998);
    expect(command).toContain('lsof -nP -tiTCP:9998 -sTCP:LISTEN');

    const pids = __test__.parsePidList('123\n 456 \ninvalid\n0\n-1\n');
    expect(pids).toEqual([123, 456]);
  });
});
