import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { OpenClawGateBlock } from '../../../src/blocks/openclaw-gate/index.js';

describe('OpenClawGateBlock plugin loading', () => {
  it('loads plugins and tools from pluginDir manifests', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-openclaw-plugin-'));
    const manifestPath = path.join(tempDir, 'plugin-a.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        id: 'plugin-a',
        name: 'Plugin A',
        version: '1.2.3',
        status: 'enabled',
        metadata: { description: 'demo plugin' },
        tools: [
          {
            id: 'tool-1',
            name: 'Tool 1',
            description: 'test tool',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
          },
        ],
      }),
      'utf-8'
    );

    const gate = new OpenClawGateBlock('gate-1', { pluginDir: tempDir });
    const plugins = gate.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe('plugin-a');
    expect(plugins[0].status).toBe('enabled');
    expect(gate.listTools()).toHaveLength(1);
    expect(gate.listTools()[0].id).toBe('tool-1');
  });
});
