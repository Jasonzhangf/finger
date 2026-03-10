import { describe, it, expect } from 'vitest';
import { OpenClawGateBlock } from '../../../src/blocks/openclaw-gate/index.js';

describe('OpenClawGateBlock', () => {
  it('installs, enables, disables and lists plugins', () => {
    const gate = new OpenClawGateBlock('gate-1');
    const plugin = gate.installPlugin('plugin-a', {
      name: 'Plugin A',
      version: '1.0.0',
      description: 'demo',
      author: 'test',
    });

    expect(plugin.id).toBe('plugin-a');
    expect(gate.listPlugins()).toHaveLength(1);
    expect(gate.listPlugins()[0].status).toBe('installed');

    gate.enablePlugin('plugin-a');
    expect(gate.listPlugins()[0].status).toBe('enabled');

    gate.disablePlugin('plugin-a');
    expect(gate.listPlugins()[0].status).toBe('disabled');
  });

  it('adds tool and only lists tools from enabled plugins', () => {
    const gate = new OpenClawGateBlock('gate-1');
    gate.installPlugin('plugin-a', { name: 'Plugin A' });
    gate.addTool('plugin-a', {
      id: 'tool-1',
      name: 'Tool 1',
      description: 'test tool',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    });

    expect(gate.listTools()).toHaveLength(0);
    gate.enablePlugin('plugin-a');
    expect(gate.listTools()).toHaveLength(1);
    expect(gate.listTools()[0].id).toBe('tool-1');
  });

  it('calls enabled tool with normalized output shape', () => {
    const gate = new OpenClawGateBlock('gate-1');
    gate.installPlugin('plugin-a', { name: 'Plugin A' });
    gate.addTool('plugin-a', {
      id: 'tool-1',
      name: 'Tool 1',
      description: 'test tool',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    });
    gate.enablePlugin('plugin-a');

    const result = gate.callTool('plugin-a', 'tool-1', { hello: 'world' });
    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      pluginId: 'plugin-a',
      toolId: 'tool-1',
      input: { hello: 'world' },
      status: 'not_implemented',
    });
  });
});
