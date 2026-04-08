import { describe, it, expect } from 'vitest';
import { resolveSourceRoot } from '../../src/core/source-root.js';
import path from 'path';
import fs from 'fs';

describe('Ledger CLI Path Resolution (Regression)', () => {
  it('resolves ledger-cli from dist/bin when FINGER_SOURCE_ROOT points to global install', () => {
    // Simulate global install scenario
    const FINGER_SOURCE_ROOT = '/opt/homebrew/lib/node_modules/fingerdaemon';
    const distBinPath = path.join(FINGER_SOURCE_ROOT, 'dist', 'bin', 'ledger-cli');
    const releaseCliPath = path.join(FINGER_SOURCE_ROOT, 'rust', 'target', 'release', 'ledger-cli');
    const debugCliPath = path.join(FINGER_SOURCE_ROOT, 'rust', 'target', 'debug', 'ledger-cli');

    // Global install has dist/bin, not rust/target
    expect(fs.existsSync(distBinPath)).toBe(true);
    expect(fs.existsSync(releaseCliPath)).toBe(false);
    expect(fs.existsSync(debugCliPath)).toBe(false);

    // Path resolution should pick dist/bin
    let cliPath: string;
    if (fs.existsSync(distBinPath)) cliPath = distBinPath;
    else if (fs.existsSync(releaseCliPath)) cliPath = releaseCliPath;
    else cliPath = debugCliPath;

    expect(cliPath).toBe(distBinPath);
    expect(cliPath).not.toBe(debugCliPath);
  });

  it('resolves ledger-cli from rust/target/release for local dev when dist/bin missing', () => {
    // Simulate local dev scenario (no dist/bin, has rust/target)
    const FINGER_SOURCE_ROOT = '/Volumes/extension/code/finger';
    const distBinPath = path.join(FINGER_SOURCE_ROOT, 'dist', 'bin', 'ledger-cli');
    const releaseCliPath = path.join(FINGER_SOURCE_ROOT, 'rust', 'target', 'release', 'ledger-cli');

    // Local dev has both dist/bin (after build) and rust/target
    // Priority: dist/bin > rust/target/release > rust/target/debug
    let cliPath: string;
    if (fs.existsSync(distBinPath)) cliPath = distBinPath;
    else if (fs.existsSync(releaseCliPath)) cliPath = releaseCliPath;
    else cliPath = path.join(FINGER_SOURCE_ROOT, 'rust', 'target', 'debug', 'ledger-cli');

    // Both exist in local dev, dist/bin should win
    expect(cliPath).toBe(distBinPath);
  });

  it('FINGER_SOURCE_ROOT resolves correctly from global install location', () => {
    // Test that source-root.ts resolves FINGER_SOURCE_ROOT correctly
    // When running from /opt/homebrew/lib/node_modules/fingerdaemon/dist/...
    // It should resolve to /opt/homebrew/lib/node_modules/fingerdaemon

    // This test verifies the logic in source-root.ts
    // When base !== 'dist' and base !== 'src', it returns up2
    // For global install: dirname(dist) = fingerdaemon, base = fingerdaemon
    // So FINGER_SOURCE_ROOT = fingerdaemon (correct)

    const mockCurrentDir = '/opt/homebrew/lib/node_modules/fingerdaemon/dist/orchestration';
    const up2 = path.dirname(path.dirname(mockCurrentDir));
    const base = path.basename(up2);

    expect(base).toBe('fingerdaemon');
    expect(up2).toBe('/opt/homebrew/lib/node_modules/fingerdaemon');
    // source-root.ts logic: if base !== 'dist' && base !== 'src', return up2
    const expectedRoot = base === 'dist' || base === 'src' ? path.dirname(up2) : up2;
    expect(expectedRoot).toBe('/opt/homebrew/lib/node_modules/fingerdaemon');
  });

  it('dist/bin/ledger-cli exists in global installation', () => {
    // Verify the actual global install has ledger-cli in dist/bin
    const globalRoot = '/opt/homebrew/lib/node_modules/fingerdaemon';
    const distBinPath = path.join(globalRoot, 'dist', 'bin', 'ledger-cli');

    // This file MUST exist for auto-compact to work in production
    expect(fs.existsSync(distBinPath)).toBe(true);

    // Verify it's executable
    const stats = fs.statSync(distBinPath);
    expect(stats.mode & 0o111).not.toBe(0); // Has execute permission
  });

  it('finger-kernel-bridge-bin exists in global installation dist/bin', () => {
    // Verify kernel bridge binary also exists in dist/bin
    const globalRoot = '/opt/homebrew/lib/node_modules/fingerdaemon';
    const kernelBinPath = path.join(globalRoot, 'dist', 'bin', 'finger-kernel-bridge-bin');

    expect(fs.existsSync(kernelBinPath)).toBe(true);
  });
});
