import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installGatewayFromCommand,
  listGatewayModules,
  removeGatewayModule,
} from '../../../src/gateway/module-registry.js';

const tempDirs: string[] = [];
const originalGatewayDir = process.env.FINGER_GATEWAY_DIR;

afterEach(() => {
  process.env.FINGER_GATEWAY_DIR = originalGatewayDir;
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('gateway module registry', () => {
  it('installs command gateway module with docs', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'finger-gateway-test-'));
    tempDirs.push(dir);
    process.env.FINGER_GATEWAY_DIR = dir;

    const installed = installGatewayFromCommand({
      id: 'echo-gateway',
      name: 'Echo Gateway',
      version: '1.0.0',
      description: 'echo gateway for tests',
      command: 'node',
      args: ['--version'],
      direction: 'output',
      supportedModes: ['sync', 'async'],
      defaultMode: 'sync',
      versionArgs: [],
    });

    expect(installed.manifest.id).toBe('echo-gateway');
    expect(installed.readmePath).toBeDefined();
    expect(installed.cliDocPath).toBeDefined();

    const listed = listGatewayModules();
    expect(listed.some((item) => item.manifest.id === 'echo-gateway')).toBe(true);

    const readmeContent = readFileSync(path.join(dir, 'echo-gateway', 'README.md'), 'utf-8');
    expect(readmeContent).toContain('Echo Gateway');
    expect(removeGatewayModule('echo-gateway')).toBe(true);
    expect(removeGatewayModule('echo-gateway')).toBe(false);
  });
});
