import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { loadModuleManifest, parseModuleManifest } from '../../../src/orchestration/module-manifest.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('module-manifest', () => {
  it('parses manifest object with required fields', () => {
    const manifest = parseModuleManifest(
      {
        id: 'demo-agent',
        type: 'agent',
        name: 'Demo Agent',
        version: '1.0.0',
        entry: './demo.js',
      },
      '/tmp/module.json',
    );

    expect(manifest.id).toBe('demo-agent');
    expect(manifest.type).toBe('agent');
    expect(manifest.entry).toBe('./demo.js');
  });

  it('resolves relative entry path against manifest directory', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'finger-module-manifest-'));
    tmpDirs.push(dir);
    const manifestPath = path.join(dir, 'demo.module.json');
    const entryPath = path.join(dir, 'demo-agent.js');
    writeFileSync(entryPath, 'export default {};', 'utf-8');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          id: 'demo-agent',
          type: 'agent',
          name: 'Demo Agent',
          version: '1.0.0',
          entry: './demo-agent.js',
        },
        null,
        2,
      ),
      'utf-8',
    );

    const loaded = loadModuleManifest(manifestPath);
    expect(loaded.manifestPath).toBe(path.resolve(manifestPath));
    expect(loaded.entryPath).toBe(path.resolve(entryPath));
  });

  it('throws for invalid type', () => {
    expect(() =>
      parseModuleManifest(
        {
          id: 'demo',
          type: 'bad-type',
          name: 'demo',
          version: '1.0.0',
          entry: './x.js',
        },
        '/tmp/module.json',
      ),
    ).toThrow('field "type" must be one of');
  });
});
