import { describe, it, expect, beforeEach } from 'vitest';
import { BlockRegistry } from '../../src/core/registry.js';
import { BaseBlock, type IBlock, type BlockCapabilities } from '../../src/core/block.js';

class MockBlock extends BaseBlock {
  readonly type = 'mock';
  readonly capabilities: BlockCapabilities = {
    functions: ['echo', 'ping'],
    cli: [
      { name: 'echo', description: 'Echo message', args: [] },
      { name: 'ping', description: 'Ping block', args: [] }
    ],
    stateSchema: {
      message: { type: 'string', readonly: false, description: 'Last message' }
    }
  };

  async execute(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'echo':
        const msg = args.message as string;
        this.updateState({ data: { message: msg } });
        return { echoed: msg };
      case 'ping':
        return { pong: true };
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }
}

describe('BlockRegistry', () => {
  let registry: BlockRegistry;

  beforeEach(() => {
    // Create fresh registry for each test
    registry = new (BlockRegistry as any)();
  });

  it('should register a block type', () => {
    registry.register({
      type: 'mock',
      factory: (config) => new MockBlock(config.id as string),
      version: '1.0.0'
    });

    expect(registry.getRegisteredTypes()).toContain('mock');
  });

  it('should create block instance', () => {
    registry.register({
      type: 'mock',
      factory: (config) => new MockBlock(config.id as string),
      version: '1.0.0'
    });

    const block = registry.createInstance('mock', 'test-1');
    expect(block.id).toBe('test-1');
    expect(block.type).toBe('mock');
  });

  it('should throw for unregistered type', () => {
    expect(() => registry.createInstance('unknown', 'test-1')).toThrow('not registered');
  });

  it('should throw for duplicate registration', () => {
    registry.register({
      type: 'mock',
      factory: (config) => new MockBlock(config.id as string),
      version: '1.0.0'
    });

    expect(() => registry.register({
      type: 'mock',
      factory: (config) => new MockBlock(config.id as string),
      version: '1.0.0'
    })).toThrow('already registered');
  });

  it('should execute block command', async () => {
    registry.register({
      type: 'mock',
      factory: (config) => new MockBlock(config.id as string),
      version: '1.0.0'
    });

    const block = registry.createInstance('mock', 'test-1');
    await block.initialize();

    const result = await registry.execute('test-1', 'ping', {});
    expect(result).toEqual({ pong: true });
  });

  it('should generate CLI routes', async () => {
    registry.register({
      type: 'mock',
      factory: (config) => new MockBlock(config.id as string),
      version: '1.0.0'
    });

    const block = registry.createInstance('mock', 'test-1');
    await block.initialize();

    const routes = registry.generateCliRoutes();
    expect(routes.length).toBe(2);
    expect(routes[0].blockId).toBe('test-1');
    expect(routes.find(r => r.command === 'echo')).toBeDefined();
    expect(routes.find(r => r.command === 'ping')).toBeDefined();
  });
});

describe('BaseBlock', () => {
  let block: MockBlock;

  beforeEach(() => {
    block = new MockBlock('test-block');
  });

  it('should initialize with idle status', async () => {
    await block.initialize();
    const state = block.getState();
    expect(state.status).toBe('idle');
    expect(state.health).toBe('healthy');
  });

  it('should start and stop', async () => {
    await block.start();
    expect(block.getState().status).toBe('running');

    await block.stop();
    expect(block.getState().status).toBe('stopped');
  });

  it('should execute commands', async () => {
    await block.initialize();
    const result = await block.execute('echo', { message: 'hello' });
    expect(result).toEqual({ echoed: 'hello' });
  });

  it('should throw for unknown command', async () => {
    await expect(block.execute('unknown', {})).rejects.toThrow('Unknown command');
  });
});
