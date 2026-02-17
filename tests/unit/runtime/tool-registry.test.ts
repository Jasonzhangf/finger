import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/runtime/tool-registry.js';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('registers and executes tools', async () => {
    registry.register({
      name: 'echo',
      description: 'Echo tool',
      inputSchema: {},
      policy: 'allow',
      handler: async (input) => input,
    });

    const result = await registry.execute('echo', { msg: 'hello' });
    expect(result).toEqual({ msg: 'hello' });
  });

  it('denies execution when policy is deny', async () => {
    registry.register({
      name: 'blocked',
      description: 'Blocked tool',
      inputSchema: {},
      policy: 'deny',
      handler: async () => 'never',
    });

    await expect(registry.execute('blocked', {})).rejects.toThrow('not allowed');
  });

  it('denies unknown tools', async () => {
    await expect(registry.execute('unknown', {})).rejects.toThrow('not found');
  });

  it('changes policy dynamically', async () => {
    registry.register({
      name: 'dynamic',
      description: 'Dynamic tool',
      inputSchema: {},
      policy: 'deny',
      handler: async () => 'ok',
    });

    await expect(registry.execute('dynamic', {})).rejects.toThrow();
    
    registry.setPolicy('dynamic', 'allow');
    const result = await registry.execute('dynamic', {});
    expect(result).toBe('ok');
  });

  it('lists tools', () => {
    registry.register({
      name: 'tool1',
      description: 'Tool 1',
      inputSchema: {},
      policy: 'allow',
      handler: async () => null,
    });
    registry.register({
      name: 'tool2',
      description: 'Tool 2',
      inputSchema: {},
      policy: 'deny',
      handler: async () => null,
    });

    const all = registry.list();
    expect(all).toHaveLength(2);

    const allowed = registry.listAllowed();
    expect(allowed).toHaveLength(1);
    expect(allowed[0].name).toBe('tool1');
  });

  it('unregisters tools', () => {
    registry.register({
      name: 'temp',
      description: 'Temp',
      inputSchema: {},
      policy: 'allow',
      handler: async () => null,
    });

    expect(registry.size).toBe(1);
    registry.unregister('temp');
    expect(registry.size).toBe(0);
  });
});
