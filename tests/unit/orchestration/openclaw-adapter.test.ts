import { describe, it, expect } from 'vitest';
import { OpenClawGateBlock } from '../../../src/blocks/openclaw-gate/index.js';
import {
  mapOpenClawMessageToInvocation,
  invokeOpenClawFromMessage,
  toOpenClawToolDefinition,
} from '../../../src/orchestration/openclaw-adapter/index.js';

describe('openclaw adapter', () => {
  it('maps openclaw-call message to invocation', () => {
    const invocation = mapOpenClawMessageToInvocation({
      type: 'openclaw-call',
      payload: {
        pluginId: 'plugin-a',
        toolId: 'tool-1',
        input: { x: 1 },
      },
    } as any);

    expect(invocation).toEqual({
      pluginId: 'plugin-a',
      toolId: 'tool-1',
      input: { x: 1 },
    });
  });

  it('invokes gate block from message', async () => {
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

    const result = await invokeOpenClawFromMessage({
      type: 'openclaw-call',
      payload: {
        pluginId: 'plugin-a',
        toolId: 'tool-1',
        input: { y: 2 },
      },
    } as any, gate);

    expect(result?.ok).toBe(true);
    expect(result?.pluginId).toBe('plugin-a');
    expect(result?.toolId).toBe('tool-1');
  });

  it('builds tool definition compatible with runtime tool registry', async () => {
    const gate = new OpenClawGateBlock('gate-1');
    gate.installPlugin('plugin-a', { name: 'Plugin A' });
    const tool = {
      id: 'tool-1',
      name: 'Tool 1',
      description: 'test tool',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    };
    gate.addTool('plugin-a', tool);
    gate.enablePlugin('plugin-a');

    const def = toOpenClawToolDefinition('plugin-a', tool, gate);
    expect(def.name).toBe('openclaw.plugin-a.tool-1');
    const result = await def.handler({ hello: 'world' });
    expect((result as any).success).toBe(true);
  });
});
