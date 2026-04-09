import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  MANAGED_PACKAGE_TOKEN,
  resolveManagedMatchers,
  matchesManagedFingerProcess,
} = require('../../../scripts/daemon-process-matchers.cjs');

describe('daemon process matchers', () => {
  const projectRoot = '/Volumes/extension/code/finger';

  it('matches workspace daemon command lines', () => {
    const command = 'node /Volumes/extension/code/finger/dist/server/index.js';
    expect(matchesManagedFingerProcess(command, projectRoot, 'dist/server/index.js')).toBe(true);
  });

  it('matches global-install daemon command lines under node_modules/fingerdaemon', () => {
    const command = 'node /opt/homebrew/lib/node_modules/fingerdaemon/dist/server/index.js';
    expect(matchesManagedFingerProcess(command, projectRoot, 'dist/server/index.js')).toBe(true);
  });

  it('matches global-install guard command lines under node_modules/fingerdaemon', () => {
    const command = 'node /opt/homebrew/lib/node_modules/fingerdaemon/scripts/daemon-guard.cjs';
    expect(matchesManagedFingerProcess(command, projectRoot, 'scripts/daemon-guard.cjs')).toBe(true);
  });

  it('does not match unrelated project daemons', () => {
    const command = 'node /Volumes/extension/code/other-project/dist/server/index.js';
    expect(matchesManagedFingerProcess(command, projectRoot, 'dist/server/index.js')).toBe(false);
  });

  it('exposes workspace and global matchers for restart/stop sanitizers', () => {
    expect(resolveManagedMatchers(projectRoot, 'dist/server/index.js')).toEqual([
      [projectRoot, 'dist/server/index.js'],
      [MANAGED_PACKAGE_TOKEN, 'dist/server/index.js'],
    ]);
  });
});
