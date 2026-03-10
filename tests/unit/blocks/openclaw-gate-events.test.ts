import { describe, it, expect, vi } from 'vitest';
import { OpenClawGateBlock } from '../../../src/blocks/openclaw-gate/index.js';
import { globalToolRegistry } from '../../../src/runtime/tool-registry.js';

describe('OpenClawGateBlock dynamic tool events', () => {
  it('should emit events on plugin lifecycle changes', () => {
    const gate = new OpenClawGateBlock('test-gate');
    const events: any[] = [];
    gate.addEventListener((event) => events.push(event));

    // Install plugin
    const plugin = gate.installPlugin('test-plugin', { name: 'Test Plugin' });
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('plugin_installed');
    expect(events[0].pluginId).toBe('test-plugin');
    expect(events[0].tools).toEqual([]);

    // Enable plugin
    gate.enablePlugin('test-plugin');
    expect(events.length).toBe(2);
    expect(events[1].type).toBe('plugin_enabled');
    expect(events[1].pluginId).toBe('test-plugin');

    // Disable plugin
    gate.disablePlugin('test-plugin');
    expect(events.length).toBe(3);
    expect(events[2].type).toBe('plugin_disabled');
    expect(events[2].pluginId).toBe('test-plugin');

    // Uninstall plugin
    gate.uninstallPlugin('test-plugin');
    expect(events.length).toBe(4);
    expect(events[3].type).toBe('plugin_uninstalled');
    expect(events[3].pluginId).toBe('test-plugin');
  });

  it('should emit events with tool information', () => {
    const gate = new OpenClawGateBlock('test-gate');
    const events: any[] = [];
    gate.addEventListener((event) => events.push(event));

    // Install plugin with tools
    const plugin = gate.installPlugin('tool-plugin', { name: 'Tool Plugin' });
    gate.addTool('tool-plugin', {
      id: 'test-tool',
      name: 'Test Tool',
      description: 'A test tool',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    });

    // Enable plugin
    gate.enablePlugin('tool-plugin');
    const enabledEvent = events.find((e) => e.type === 'plugin_enabled');
    expect(enabledEvent).toBeDefined();
    expect(enabledEvent.tools.length).toBe(1);
    expect(enabledEvent.tools[0].id).toBe('test-tool');

    // Disable plugin
    gate.disablePlugin('tool-plugin');
    const disabledEvent = events.find((e) => e.type === 'plugin_disabled');
    expect(disabledEvent).toBeDefined();
    expect(disabledEvent.toolNames.length).toBe(1);
    expect(disabledEvent.toolNames[0]).toBe('openclaw.tool-plugin.test-tool');
  });

  it('should support multiple event listeners', () => {
    const gate = new OpenClawGateBlock('test-gate');
    const events1: any[] = [];
    const events2: any[] = [];
    gate.addEventListener((event) => events1.push(event));
    gate.addEventListener((event) => events2.push(event));

    gate.installPlugin('multi-listener', { name: 'Multi Listener' });

    expect(events1.length).toBe(1);
    expect(events2.length).toBe(1);
    expect(events1[0].pluginId).toBe('multi-listener');
    expect(events2[0].pluginId).toBe('multi-listener');
  });
});
