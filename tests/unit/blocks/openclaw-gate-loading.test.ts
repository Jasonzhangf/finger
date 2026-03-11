import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { OpenClawGateBlock } from '../../../src/blocks/openclaw-gate/index.js';

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writePlugin(pluginRoot: string, params: { id: string; body?: string; tools?: { id: string; name: string }[] }) {
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, 'package.json'),
    JSON.stringify(
      {
        name: params.id,
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

  const toolsCode = params.tools?.map(t => 
    `api.registerTool({ id: '${t.id}', name: '${t.name}', description: '${t.name} tool', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } });`
  ).join('\n') || '';

  fs.writeFileSync(
    path.join(pluginRoot, 'index.js'),
    params.body || `export default {
      id: '${params.id}',
      register(api) {
        ${toolsCode}
      }
    };`,
    'utf-8',
  );
}

afterEach(() => {
  for (const dir of tempRoots.splice(0, tempRoots.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.OPENCLAW_STATE_DIR;
});

describe('OpenClawGateBlock plugin loading', () => {
  it('loads plugins and tools from pluginDir manifests', async () => {
    const tempDir = makeTempDir('finger-openclaw-plugin-');
    const openclawHome = makeTempDir('finger-openclaw-home-');
    process.env.OPENCLAW_STATE_DIR = openclawHome;
    const pluginDir = path.join(tempDir, 'plugin-a');
    
    writePlugin(pluginDir, {
      id: 'plugin-a',
      tools: [
        { id: 'tool-1', name: 'Tool 1' },
      ],
    });

    const gate = new OpenClawGateBlock('gate-1', { pluginDir: tempDir });
    await gate.initialize();
    const plugins = gate.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe('plugin-a');
    expect(plugins[0].status).toBe('enabled');
    expect(gate.listTools()).toHaveLength(1);
    expect(gate.listTools()[0].id).toBe('tool-1');
  });
});
