import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BlockRegistry } from '../../../src/core/registry.js';
import type { IBlock, BlockRegistration } from '../../../src/core/block.js';

describe('BlockRegistry', () => {
  let registry: BlockRegistry;

  beforeEach(() => {
    registry = BlockRegistry.getInstance();
    (registry as any).blocks.clear();
    (registry as any).registrations.clear();
  });

  describe('createInstance', () => {
    it('should create block instance from registered type', () => {
      const registration: BlockRegistration = {
        type: 'test-block',
        factory: (config) => ({
          id: config.id,
          type: 'test-block',
          capabilities: { functions: [], cli: [], stateSchema: {} },
          initialize: vi.fn().mockResolvedValue(undefined),
          execute: vi.fn().mockResolvedValue(undefined),
          getState: vi.fn().mockReturnValue({ data: {} }),
          updateState: vi.fn(),
        } as IBlock),
      };
      registry.register(registration);
      const instance = registry.createInstance('test-block', 'test-1');
      expect(instance.id).toBe('test-1');
      expect(instance.type).toBe('test-block');
    });

    it('should throw for unregistered type', () => {
      expect(() => registry.createInstance('unknown-type', 'test-1')).toThrow('not registered');
    });
  });

  describe('getBlock', () => {
    it('should return block by id', () => {
      const registration: BlockRegistration = {
        type: 'test-block',
        factory: (config) => ({
          id: config.id,
          type: 'test-block',
          capabilities: { functions: [], cli: [], stateSchema: {} },
          initialize: vi.fn().mockResolvedValue(undefined),
          execute: vi.fn().mockResolvedValue(undefined),
          getState: vi.fn().mockReturnValue({ data: {} }),
          updateState: vi.fn(),
        } as IBlock),
      };
      registry.register(registration);
      const instance = registry.createInstance('test-block', 'test-1');
      const retrieved = registry.getBlock('test-1');
      expect(retrieved).toBe(instance);
    });

    it('should return undefined for non-existent block', () => {
      const retrieved = registry.getBlock('non-existent');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('execute', () => {
    it('should execute command on block', async () => {
      const mockExecute = vi.fn().mockResolvedValue({ result: 'success' });
      const registration: BlockRegistration = {
        type: 'test-block',
        factory: (config) => ({
          id: config.id,
          type: 'test-block',
          capabilities: { functions: [], cli: [], stateSchema: {} },
          initialize: vi.fn().mockResolvedValue(undefined),
          execute: mockExecute,
          getState: vi.fn().mockReturnValue({ data: {} }),
          updateState: vi.fn(),
        } as IBlock),
      };
      registry.register(registration);
      registry.createInstance('test-block', 'test-1');
      const result = await registry.execute('test-1', 'test-command', { arg: 'value' });
      expect(mockExecute).toHaveBeenCalledWith('test-command', { arg: 'value' });
      expect(result).toEqual({ result: 'success' });
    });

    it('should throw for non-existent block', async () => {
      await expect(registry.execute('non-existent', 'cmd', {})).rejects.toThrow('not found');
    });
  });

  describe('generateCliRoutes', () => {
    it('should generate CLI routes from blocks', () => {
      const registration: BlockRegistration = {
        type: 'test-block',
        factory: (config) => ({
          id: config.id,
          type: 'test-block',
          capabilities: {
            functions: [],
            cli: [{ name: 'cmd1', description: 'Command 1', args: [] }],
            stateSchema: {},
          },
          initialize: vi.fn().mockResolvedValue(undefined),
          execute: vi.fn().mockResolvedValue(undefined),
          getState: vi.fn().mockReturnValue({ data: {} }),
          updateState: vi.fn(),
        } as IBlock),
      };
      registry.register(registration);
      registry.createInstance('test-block', 'test-1');
      const routes = registry.generateCliRoutes();
      expect(routes.length).toBe(1);
      expect(routes[0].command).toBe('cmd1');
    });
  });
});
