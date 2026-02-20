import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModuleRegistry, type InputModule, type OutputModule, type AgentModule } from '../../../src/orchestration/module-registry.js';
import { MessageHub } from '../../../src/orchestration/message-hub.js';

vi.mock('../../../src/orchestration/message-hub.js', () => ({
  MessageHub: vi.fn().mockImplementation(() => ({
    registerInput: vi.fn(),
    registerOutput: vi.fn(),
    addRoute: vi.fn().mockReturnValue('route-1'),
    routeToOutput: vi.fn().mockResolvedValue({}),
  })),
}));

describe('ModuleRegistry', () => {
  let registry: ModuleRegistry;
  let mockHub: MessageHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHub = new MessageHub() as any;
    registry = new ModuleRegistry(mockHub);
  });

  describe('register', () => {
    it('should register an input module', async () => {
      const inputModule: InputModule = {
        id: 'input-1',
        type: 'input',
        name: 'Test Input',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
        defaultRoutes: ['output-1'],
      };

      await registry.register(inputModule);
      const module = registry.getModule('input-1');
      expect(module).toBeDefined();
      expect(module?.type).toBe('input');
    });

    it('should register an output module', async () => {
      const outputModule: OutputModule = {
        id: 'output-1',
        type: 'output',
        name: 'Test Output',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
      };

      await registry.register(outputModule);
      const module = registry.getModule('output-1');
      expect(module).toBeDefined();
      expect(module?.type).toBe('output');
    });

    it('should register an agent module', async () => {
      const agentModule: AgentModule = {
        id: 'agent-1',
        type: 'agent',
        name: 'Test Agent',
        version: '1.0.0',
        capabilities: ['execute', 'query'],
        execute: vi.fn().mockResolvedValue({}),
      };

      await registry.register(agentModule);
      const module = registry.getModule('agent-1');
      expect(module).toBeDefined();
      expect(module?.type).toBe('agent');
    });

    it('should throw for duplicate module id', async () => {
      const inputModule: InputModule = {
        id: 'input-1',
        type: 'input',
        name: 'Test Input',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
      };

      await registry.register(inputModule);
      await expect(registry.register(inputModule)).rejects.toThrow('already registered');
    });
  });

  describe('unregister', () => {
    it('should unregister a module', async () => {
      const inputModule: InputModule = {
        id: 'input-1',
        type: 'input',
        name: 'Test Input',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
      };

      await registry.register(inputModule);
      const result = await registry.unregister('input-1');
      expect(result).toBe(true);
      expect(registry.getModule('input-1')).toBeUndefined();
    });

    it('should return false for non-existent module', async () => {
      const result = await registry.unregister('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('getAllModules', () => {
    it('should return all registered modules', async () => {
      await registry.register({
        id: 'input-1',
        type: 'input',
        name: 'Input',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
      });
      await registry.register({
        id: 'output-1',
        type: 'output',
        name: 'Output',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
      });

      const modules = registry.getAllModules();
      expect(modules.length).toBe(2);
    });
  });

  describe('getModulesByType', () => {
    it('should return modules filtered by type', async () => {
      await registry.register({
        id: 'input-1',
        type: 'input',
        name: 'Input 1',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
      });
      await registry.register({
        id: 'input-2',
        type: 'input',
        name: 'Input 2',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
      });
      await registry.register({
        id: 'output-1',
        type: 'output',
        name: 'Output',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
      });

      const inputModules = registry.getModulesByType('input');
      expect(inputModules.length).toBe(2);
    });
  });

  describe('createRoute', () => {
    it('should create a dynamic route', () => {
      const routeId = registry.createRoute('test.pattern', 'output-1', {
        blocking: false,
        priority: 1,
        description: 'Test route',
      });
      expect(routeId).toBe('route-1');
    });
  });
});
