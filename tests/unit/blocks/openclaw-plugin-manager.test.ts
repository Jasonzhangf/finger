/**
 * OpenClaw Plugin Manager Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createPluginManager, PluginManager } from '../../../src/blocks/openclaw-plugin-manager/index.js';
import { loadPluginManifest, parsePackageJsonExtensions } from '../../../src/blocks/openclaw-plugin-manager/manifest.js';
import { discoverPlugins } from '../../../src/blocks/openclaw-plugin-manager/loader.js';

const TEST_DIR = '/tmp/finger-plugin-test-' + Date.now();
const PLUGIN_DIR = path.join(TEST_DIR, 'plugins');

function setupTestPlugin(name: string, manifest: Record<string, unknown>) {
  const pluginPath = path.join(PLUGIN_DIR, name);
  fs.mkdirSync(pluginPath, { recursive: true });
  fs.writeFileSync(
    path.join(pluginPath, 'openclaw.plugin.json'),
    JSON.stringify(manifest, null, 2)
  );
  return pluginPath;
}

describe('OpenClaw Plugin Manager', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    delete process.env.OPENCLAW_STATE_DIR;
  });

  describe('Manifest Loading', () => {
    it('should load valid plugin manifest', () => {
      const pluginPath = setupTestPlugin('test-plugin', {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        channels: ['discord', 'slack'],
      });

      const result = loadPluginManifest(pluginPath);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.manifest.id).toBe('test-plugin');
        expect(result.manifest.name).toBe('Test Plugin');
        expect(result.manifest.channels).toEqual(['discord', 'slack']);
      }
    });

    it('should fail on missing manifest', () => {
      const emptyDir = path.join(PLUGIN_DIR, 'empty');
      fs.mkdirSync(emptyDir, { recursive: true });

      const result = loadPluginManifest(emptyDir);
      expect(result.ok).toBe(false);
    });

    it('should fail on missing id field', () => {
      const pluginPath = setupTestPlugin('no-id', {
        name: 'No ID Plugin',
      });

      const result = loadPluginManifest(pluginPath);
      expect(result.ok).toBe(false);
    });
  });

  describe('Package.json Parsing', () => {
    it('should parse openclaw extensions from package.json', () => {
      const pluginPath = setupTestPlugin('pkg-plugin', { id: 'pkg-plugin' });
      fs.writeFileSync(
        path.join(pluginPath, 'package.json'),
        JSON.stringify({
          name: 'pkg-plugin',
          version: '1.0.0',
          openclaw: {
            id: 'pkg-plugin',
            extensions: ['./dist/index.js'],
          },
        })
      );

      const result = parsePackageJsonExtensions(path.join(pluginPath, 'package.json'));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pluginId).toBe('pkg-plugin');
        expect(result.extensions).toEqual(['./dist/index.js']);
      }
    });

    it('should fail on missing openclaw field', () => {
      const pluginPath = setupTestPlugin('no-openclaw', { id: 'no-openclaw' });
      fs.writeFileSync(
        path.join(pluginPath, 'package.json'),
        JSON.stringify({
          name: 'no-openclaw',
        })
      );

      const result = parsePackageJsonExtensions(path.join(pluginPath, 'package.json'));
      expect(result.ok).toBe(false);
    });
  });

  describe('Plugin Discovery', () => {
    it('should discover plugins in directory', () => {
      // Isolate from global plugins
      process.env.OPENCLAW_STATE_DIR = TEST_DIR;
      setupTestPlugin('plugin-a', { id: 'plugin-a' });
      setupTestPlugin('plugin-b', { id: 'plugin-b' });

      const plugins = discoverPlugins(PLUGIN_DIR);
      expect(plugins.length).toBe(2);
      expect(plugins.some(p => p.endsWith('plugin-a'))).toBe(true);
      expect(plugins.some(p => p.endsWith('plugin-b'))).toBe(true);
    });

    it('should return empty array for non-existent directory', () => {
      // Isolate from global plugins
      process.env.OPENCLAW_STATE_DIR = TEST_DIR;
      const plugins = discoverPlugins('/non/existent/path');
      expect(plugins).toEqual([]);
    });
  });

  describe('PluginManager', () => {
    it('should create plugin manager instance', () => {
      const manager = createPluginManager({ pluginDir: PLUGIN_DIR });
      expect(manager).toBeInstanceOf(PluginManager);
    });

    it('should list installed plugins', () => {
      setupTestPlugin('test-1', { id: 'test-1' });
      setupTestPlugin('test-2', { id: 'test-2' });

      const manager = createPluginManager({ pluginDir: PLUGIN_DIR });
      const installed = manager.listInstalled();
      expect(installed.length).toBe(2);
    });

    it('should load all plugins', async () => {
      // Isolate from global plugins
      process.env.OPENCLAW_STATE_DIR = TEST_DIR;
      setupTestPlugin('load-test', {
        id: 'load-test',
        name: 'Load Test Plugin',
        version: '1.0.0',
      });

      const manager = createPluginManager({ pluginDir: PLUGIN_DIR });
      const records = await manager.loadAll();
      expect(records.length).toBe(1);
      expect(records[0].id).toBe('load-test');
    });

    it('should get plugin by ID', async () => {
      setupTestPlugin('get-test', { id: 'get-test' });

      const manager = createPluginManager({ pluginDir: PLUGIN_DIR });
      await manager.loadAll();

      const plugin = manager.getPlugin('get-test');
      expect(plugin).toBeDefined();
      expect(plugin?.id).toBe('get-test');
    });

    it('should enable/disable plugins', async () => {
      setupTestPlugin('toggle-test', { id: 'toggle-test' });

      const manager = createPluginManager({ pluginDir: PLUGIN_DIR });
      await manager.loadAll();

      expect(manager.disable('toggle-test')).toBe(true);
      const disabled = manager.getPlugin('toggle-test');
      expect(disabled?.enabled).toBe(false);

      expect(manager.enable('toggle-test')).toBe(true);
      const enabled = manager.getPlugin('toggle-test');
      expect(enabled?.enabled).toBe(true);
    });
  });
});
