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
  it('should call allowAll to set all tools to allow', () => {
    registry.register({
      name: 'tool-allow',
      description: 'Allow test',
      inputSchema: {},
      policy: 'deny',
      handler: vi.fn(),
    });
    expect(registry.getPolicy('tool-allow')).toBe('deny');
    registry.allowAll();
    expect(registry.getPolicy('tool-allow')).toBe('allow');
  });
  it('should call denyAll to set all tools to deny', () => {
    registry.register({
      name: 'tool-deny',
      description: 'Deny test',
      inputSchema: {},
      policy: 'allow',
      handler: vi.fn(),
    });
    expect(registry.getPolicy('tool-deny')).toBe('allow');
    registry.denyAll();
    expect(registry.getPolicy('tool-deny')).toBe('deny');
  });
  it('should clear registry', () => {
    registry.register({
      name: 'clear-tool',
      description: 'To be cleared',
      inputSchema: {},
      policy: 'allow',
      handler: vi.fn(),
    });
    expect(registry.size).toBe(1);
    registry.clear();
    expect(registry.size).toBe(0);
  });
  it('should return size correctly', () => {
    registry.register({
      name: 'size-tool-1',
      description: 'Size 1',
      inputSchema: {},
      policy: 'allow',
      handler: vi.fn(),
    });
    registry.register({
      name: 'size-tool-2',
      description: 'Size 2',
      inputSchema: {},
      policy: 'allow',
      handler: vi.fn(),
    });
    expect(registry.size).toBe(2);
  });
});
