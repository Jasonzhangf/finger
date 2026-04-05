import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { getFingerAppVersion } from '../../../src/core/app-version.js';

describe('app-version', () => {
  it('returns package.json version as the canonical app version', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { version?: string };

    expect(getFingerAppVersion()).toBe(pkg.version);
  });
});
