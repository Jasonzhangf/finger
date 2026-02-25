import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installCliPluginManifest,
  listInstalledCliPlugins,
  loadDynamicCliPlugins,
  removeCliPluginManifest,
} from '../../../src/cli/plugin-loader.js';

const tmpDirs: string[] = [];
const originalPluginDir = process.env.FINGER_CLI_PLUGIN_DIR;
const originalCapabilityDir = process.env.FINGER_CLI_CAPABILITY_DIR;

afterEach(() => {
  process.env.FINGER_CLI_PLUGIN_DIR = originalPluginDir;
  process.env.FINGER_CLI_CAPABILITY_DIR = originalCapabilityDir;
  for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('cli plugin loader', () => {
  it('installs plugin manifest and normalizes entry path', () => {
    const sourceDir = mkdtempSync(path.join(os.tmpdir(), 'finger-plugin-source-'));
    const installDir = mkdtempSync(path.join(os.tmpdir(), 'finger-plugin-install-'));
    const capabilityDir = mkdtempSync(path.join(os.tmpdir(), 'finger-capability-install-'));
    tmpDirs.push(sourceDir, installDir, capabilityDir);
    process.env.FINGER_CLI_PLUGIN_DIR = installDir;
    process.env.FINGER_CLI_CAPABILITY_DIR = capabilityDir;

    const entryPath = path.join(sourceDir, 'hello-plugin.js');
    const manifestPath = path.join(sourceDir, 'hello.module.json');
    writeFileSync(
      entryPath,
      'export default { register(program) { program.command("hello-plugin").description("hello"); } };',
      'utf-8',
    );
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          id: 'hello-plugin',
          type: 'cli-plugin',
          name: 'Hello Plugin',
          version: '1.0.0',
          entry: './hello-plugin.js',
        },
        null,
        2,
      ),
      'utf-8',
    );

    const installed = installCliPluginManifest(manifestPath);
    expect(installed.id).toBe('hello-plugin');

    const stored = JSON.parse(readFileSync(installed.manifestPath, 'utf-8')) as { entry: string };
    expect(stored.entry).toBe(path.resolve(entryPath));
  });

  it('loads installed plugins and registers dynamic commands', async () => {
    const sourceDir = mkdtempSync(path.join(os.tmpdir(), 'finger-plugin-source-'));
    const installDir = mkdtempSync(path.join(os.tmpdir(), 'finger-plugin-install-'));
    const capabilityDir = mkdtempSync(path.join(os.tmpdir(), 'finger-capability-install-'));
    tmpDirs.push(sourceDir, installDir, capabilityDir);
    process.env.FINGER_CLI_PLUGIN_DIR = installDir;
    process.env.FINGER_CLI_CAPABILITY_DIR = capabilityDir;

    const entryPath = path.join(sourceDir, 'dynamic-plugin.js');
    const manifestPath = path.join(sourceDir, 'dynamic.module.json');
    writeFileSync(
      entryPath,
      [
        'export default {',
        '  register(program) {',
        '    program.command("dynamic-hello").description("dynamic command");',
        '  }',
        '};',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          id: 'dynamic-plugin',
          type: 'cli-plugin',
          name: 'Dynamic Plugin',
          version: '1.0.0',
          entry: './dynamic-plugin.js',
        },
        null,
        2,
      ),
      'utf-8',
    );

    installCliPluginManifest(manifestPath);
    const installed = listInstalledCliPlugins();
    expect(installed.length).toBe(1);
    expect(installed[0].id).toBe('dynamic-plugin');

    const program = new Command();
    const result = await loadDynamicCliPlugins(program, {
      defaultHttpBaseUrl: 'http://localhost:9999',
      defaultWsUrl: 'ws://localhost:9999',
      cliVersion: '1.0.0',
    });
    expect(result.failed).toEqual([]);
    expect(result.loaded).toEqual(['dynamic-plugin']);
    expect(program.commands.some((cmd) => cmd.name() === 'dynamic-hello')).toBe(true);
  });

  it('removes installed plugin by id', () => {
    const sourceDir = mkdtempSync(path.join(os.tmpdir(), 'finger-plugin-source-'));
    const installDir = mkdtempSync(path.join(os.tmpdir(), 'finger-plugin-install-'));
    const capabilityDir = mkdtempSync(path.join(os.tmpdir(), 'finger-capability-install-'));
    tmpDirs.push(sourceDir, installDir, capabilityDir);
    process.env.FINGER_CLI_PLUGIN_DIR = installDir;
    process.env.FINGER_CLI_CAPABILITY_DIR = capabilityDir;

    const entryPath = path.join(sourceDir, 'rm-plugin.js');
    const manifestPath = path.join(sourceDir, 'rm.module.json');
    writeFileSync(entryPath, 'export default { register() {} };', 'utf-8');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          id: 'rm-plugin',
          type: 'cli-plugin',
          name: 'RM Plugin',
          version: '1.0.0',
          entry: './rm-plugin.js',
        },
        null,
        2,
      ),
      'utf-8',
    );
    installCliPluginManifest(manifestPath);
    expect(removeCliPluginManifest('rm-plugin')).toBe(true);
    expect(removeCliPluginManifest('rm-plugin')).toBe(false);
  });
});
