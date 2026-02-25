import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installCliCapabilityDescriptor,
  installCliCapabilityFromCommand,
  listInstalledCliCapabilities,
  parseCliCapabilityDescriptor,
  registerCliCapabilityAliases,
  removeCliCapabilityDescriptor,
  resolveAvailableCliCapabilities,
} from '../../../src/cli/cli-capability-loader.js';

const tmpDirs: string[] = [];
const originalCapabilityDir = process.env.FINGER_CLI_TOOL_CAPABILITY_DIR;

afterEach(() => {
  process.env.FINGER_CLI_TOOL_CAPABILITY_DIR = originalCapabilityDir;
  for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('cli capability loader', () => {
  it('parses capability descriptor', () => {
    const descriptor = parseCliCapabilityDescriptor(
      {
        id: 'demo-cli',
        name: 'Demo CLI',
        version: '1.0.0',
        description: 'demo descriptor',
        command: 'node',
      },
      '/tmp/demo.capability.json',
    );
    expect(descriptor.id).toBe('demo-cli');
    expect(descriptor.command).toBe('node');
  });

  it('installs descriptor file and lists installed capabilities', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'finger-capability-tools-'));
    tmpDirs.push(dir);
    process.env.FINGER_CLI_TOOL_CAPABILITY_DIR = dir;

    const sourcePath = path.join(dir, 'source.capability.json');
    writeFileSync(
      sourcePath,
      JSON.stringify(
        {
          id: 'git-cli',
          name: 'Git CLI',
          version: '1.0.0',
          description: 'git capability',
          command: 'git',
        },
        null,
        2,
      ),
      'utf-8',
    );

    const installed = installCliCapabilityDescriptor(sourcePath);
    expect(installed.descriptor.id).toBe('git-cli');

    const content = JSON.parse(readFileSync(installed.filePath!, 'utf-8')) as { id: string };
    expect(content.id).toBe('git-cli');
    const installedDir = path.dirname(installed.filePath!);
    expect(existsSync(path.join(installedDir, 'README.md'))).toBe(true);
    expect(existsSync(path.join(installedDir, 'cli.md'))).toBe(true);

    const listed = listInstalledCliCapabilities();
    expect(listed.some((item) => item.descriptor.id === 'git-cli')).toBe(true);
    expect(listed.some((item) => item.descriptor.id === 'bd')).toBe(true);
  });

  it('loads available capabilities and registers alias command', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'finger-capability-tools-'));
    tmpDirs.push(dir);
    process.env.FINGER_CLI_TOOL_CAPABILITY_DIR = dir;

    installCliCapabilityFromCommand(
      'node-cap',
      'Node Capability',
      'node',
      'node as global cli capability',
      '1.0.0',
      ['--version'],
    );

    const available = resolveAvailableCliCapabilities();
    expect(available.some((item) => item.id === 'node-cap')).toBe(true);

    const program = new Command();
    const result = await registerCliCapabilityAliases(program);
    expect(result.loaded.some((id) => id === 'node-cap')).toBe(true);
    expect(program.commands.some((cmd) => cmd.name() === 'node-cap')).toBe(true);

    expect(removeCliCapabilityDescriptor('node-cap')).toBe(true);
    expect(removeCliCapabilityDescriptor('node-cap')).toBe(false);
  });

  it('loads docs into runtime description when module directory exists', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'finger-capability-tools-'));
    tmpDirs.push(dir);
    process.env.FINGER_CLI_TOOL_CAPABILITY_DIR = dir;

    const moduleDir = path.join(dir, 'demo-cap');
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(
      path.join(moduleDir, 'module.json'),
      JSON.stringify(
        {
          id: 'demo-cap',
          name: 'Demo Cap',
          version: '1.0.0',
          description: 'demo capability',
          command: 'node',
          helpArgs: ['--help'],
          versionArgs: ['--version'],
          readmeFile: 'README.md',
          cliDocFile: 'cli.md',
          enabled: true,
        },
        null,
        2,
      ),
      'utf-8',
    );
    writeFileSync(path.join(moduleDir, 'README.md'), '# Demo README', 'utf-8');
    writeFileSync(path.join(moduleDir, 'cli.md'), '# Demo CLI', 'utf-8');

    const listed = listInstalledCliCapabilities();
    const demo = listed.find((item) => item.descriptor.id === 'demo-cap');
    expect(demo).toBeDefined();
    expect(demo?.descriptor.docs?.readmePath).toBe(path.join(moduleDir, 'README.md'));
    expect(demo?.descriptor.docs?.cliDocPath).toBe(path.join(moduleDir, 'cli.md'));
    expect(demo?.descriptor.runtimeDescription).toContain('L3/详细文档');
  });
});
