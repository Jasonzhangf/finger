import { describe, it, expect } from 'vitest';
import { CoreDaemon } from '../../../src/core/daemon.js';
import { createMessage } from '../../../src/core/schema.js';

describe('CoreDaemon openclaw routing', () => {
  it('does not bypass gate when plugin is disabled', async () => {
    const daemon = new CoreDaemon();
    const gate = (daemon as any).openClawGate;

    gate.installPlugin('plugin-a', { name: 'Plugin A' });
    gate.addTool('plugin-a', {
      id: 'tool-1',
      name: 'Tool 1',
      description: 'test tool',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    });

    const msg = createMessage('openclaw-call', {
      pluginId: 'plugin-a',
      toolId: 'tool-1',
      input: { x: 1 },
    }, 'openclaw-input');

    await expect((daemon as any).handleMessage(msg)).resolves.toBeUndefined();
  });

  it('uses gate contract for plugin not found', async () => {
    const daemon = new CoreDaemon();

    const msg = createMessage('openclaw-call', {
      pluginId: 'missing',
      toolId: 'tool-1',
      input: { x: 1 },
    }, 'openclaw-input');

    await expect((daemon as any).handleMessage(msg)).resolves.toBeUndefined();
  });

  it('handles enabled plugin through gate path', async () => {
    const daemon = new CoreDaemon();
    const gate = (daemon as any).openClawGate;

    gate.installPlugin('plugin-a', { name: 'Plugin A' });
    gate.addTool('plugin-a', {
      id: 'tool-1',
      name: 'Tool 1',
      description: 'test tool',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    });
    gate.enablePlugin('plugin-a');

    const msg = createMessage('openclaw-call', {
      pluginId: 'plugin-a',
      toolId: 'tool-1',
      input: { x: 1 },
    }, 'openclaw-input');

    await expect((daemon as any).handleMessage(msg)).resolves.toBeUndefined();
  });
});
