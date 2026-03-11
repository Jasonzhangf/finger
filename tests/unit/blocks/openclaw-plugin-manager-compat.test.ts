import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenClawGateBlock } from '../../../src/blocks/openclaw-gate/index.js';
import { discoverPluginsDetailed } from '../../../src/blocks/openclaw-plugin-manager/loader.js';

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writePlugin(pluginRoot: string, params: { id: string; body: string; packageName?: string }) {
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, 'package.json'),
    JSON.stringify(
      {
        name: params.packageName ?? params.id,
        version: '1.0.0',
        type: 'module',
        openclaw: {
          id: params.id,
          extensions: ['./index.js'],
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(pluginRoot, 'openclaw.plugin.json'),
    JSON.stringify({ id: params.id, channels: [params.id], configSchema: { type: 'object', properties: {} } }, null, 2),
  );
  fs.writeFileSync(path.join(pluginRoot, 'index.js'), params.body, 'utf-8');
}

afterEach(() => {
  for (const dir of tempRoots.splice(0, tempRoots.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.CLAWDBOT_STATE_DIR;
});

describe('OpenClaw standard plugin compatibility', () => {
  it('loads standard OpenClaw plugin and registers channel/gateway tools', async () => {
    const fingerDir = makeTempDir('finger-openclaw-finger-');
    const openclawHome = makeTempDir('finger-openclaw-home-');
    process.env.OPENCLAW_STATE_DIR = openclawHome;
    const extensionsDir = path.join(openclawHome, 'extensions');
    const pluginDir = path.join(extensionsDir, 'weibo');

    writePlugin(pluginDir, {
      id: 'weibo',
      body: `export default {
        id: 'weibo',
        register(api) {
          api.registerChannel({ plugin: { id: 'weibo', meta: { label: 'Weibo', blurb: 'Weibo DM channel' }, configSchema: { schema: { type: 'object', properties: { enabled: { type: 'boolean' } } } } } });
          api.registerGatewayMethod('weibo.reconnect', async ({ respond }) => respond(true, { ok: true }));
        }
      };`,
    });

    const gate = new OpenClawGateBlock('gate-compat', { pluginDir: fingerDir });
    await gate.initialize();

    const plugins = gate.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe('weibo');
    expect(plugins[0].metadata.sourceKind).toBe('openclaw');
    expect(gate.listTools('weibo').map((tool) => tool.id).sort()).toEqual([
      'channel.weibo',
      'gateway.weibo.reconnect',
    ]);
  });

  it('prefers finger plugin dir over openclaw extensions for same plugin id', async () => {
    const fingerDir = makeTempDir('finger-openclaw-finger-');
    const openclawHome = makeTempDir('finger-openclaw-home-');
    process.env.OPENCLAW_STATE_DIR = openclawHome;
    const extensionsDir = path.join(openclawHome, 'extensions');

    writePlugin(path.join(extensionsDir, 'dup-plugin'), {
      id: 'dup-plugin',
      body: `export default { id: 'dup-plugin', register(api) { api.registerGatewayMethod('dup.from.openclaw', async ({ respond }) => respond(true, { ok: true })); } };`,
    });

    writePlugin(path.join(fingerDir, 'dup-plugin'), {
      id: 'dup-plugin',
      body: `export default { id: 'dup-plugin', register(api) { api.registerGatewayMethod('dup.from.finger', async ({ respond }) => respond(true, { ok: true })); } };`,
    });

    const discovered = discoverPluginsDetailed(fingerDir);
    expect(discovered.filter((item) => item.pluginId === 'dup-plugin')).toHaveLength(1);
    expect(discovered.find((item) => item.pluginId === 'dup-plugin')?.sourceKind).toBe('finger');

    const gate = new OpenClawGateBlock('gate-priority', { pluginDir: fingerDir });
    await gate.initialize();

    const plugin = gate.listPlugins().find((item) => item.id === 'dup-plugin');
    expect(plugin?.metadata.sourceKind).toBe('finger');
    expect(gate.listTools('dup-plugin').map((tool) => tool.id)).toEqual(['gateway.dup.from.finger']);
  });
});
