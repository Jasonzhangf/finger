import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModuleRegistry, type InputModule, type OutputModule, type AgentModule } from '../../../src/orchestration/module-registry.js';
import { MessageHub } from '../../../src/orchestration/message-hub.js';

vi.mock('../../../src/orchestration/message-hub.js', () => ({
  MessageHub: vi.fn().mockImplementation(() => ({
    registerInput: vi.fn(),
    registerOutput: vi.fn(),
    unregisterInput: vi.fn(),
    unregisterOutput: vi.fn(),
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

    it('should throw for version conflict', async () => {
      const moduleV1: InputModule = {
        id: 'input-1',
        type: 'input',
        name: 'Test Input',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
      };

      const moduleV2: InputModule = {
        id: 'input-1',
        type: 'input',
        name: 'Test Input',
        version: '2.0.0',
        handle: vi.fn().mockResolvedValue({}),
      };

      await registry.register(moduleV1);
      await expect(registry.register(moduleV2)).rejects.toThrow('version conflict');

      // Verify error is tracked
      const error = registry.getRegistrationError('input-1');
      expect(error).toBeDefined();
      expect(error?.message).toContain('version conflict');
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

    it('should clear registration error on unregister', async () => {
      const moduleV1: InputModule = {
        id: 'input-1',
        type: 'input',
        name: 'Test Input',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
      };

      const moduleV2: InputModule = {
        id: 'input-1',
        type: 'input',
        name: 'Test Input',
        version: '2.0.0',
        handle: vi.fn().mockResolvedValue({}),
      };

      await registry.register(moduleV1);
      try {
        await registry.register(moduleV2);
      } catch (e) {
        // Expected to throw
      }

      expect(registry.getRegistrationError('input-1')).toBeDefined();
      await registry.unregister('input-1');
      expect(registry.getRegistrationError('input-1')).toBeUndefined();
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

  describe('initialize and destroy', () => {
    it('should call module initialize hook', async () => {
      const initFn = vi.fn();
      const inputModule: InputModule = {
        id: 'input-init',
        type: 'input',
        name: 'Init Input',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
        initialize: initFn,
      };

      await registry.register(inputModule);
      expect(initFn).toHaveBeenCalledWith(mockHub);
    });

    it('should call module destroy hook on unregister', async () => {
      const destroyFn = vi.fn();
      const inputModule: InputModule = {
        id: 'input-destroy',
        type: 'input',
        name: 'Destroy Input',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
        destroy: destroyFn,
      };

      await registry.register(inputModule);
      await registry.unregister('input-destroy');
      expect(destroyFn).toHaveBeenCalled();
    });
  });

  describe('getModule', () => {
    it('should return undefined for non-existent module', () => {
      const result = registry.getModule('non-existent');
      expect(result).toBeUndefined();
    });
  });

  describe('createRoute with function pattern', () => {
    it('should support function patterns', () => {
      const routeId = registry.createRoute(
        (msg) => msg.priority > 5,
        'output-high',
        { blocking: true, priority: 10 }
      );
      expect(routeId).toBe('route-1');
    });

    it('should support RegExp patterns', () => {
      const routeId = registry.createRoute(/api\..+/, 'output-api');
      expect(routeId).toBe('route-1');
    });
  });

  describe('health check', () => {
    it('should return healthy status for module without health check', async () => {
      const inputModule: InputModule = {
        id: 'input-1',
        type: 'input',
        name: 'Test Input',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
      };

      await registry.register(inputModule);
      const health = await registry.checkHealth('input-1');
      expect(health).toEqual({
        status: 'healthy',
        version: '1.0.0',
      });
    });

    it('should return custom health status when health check implemented', async () => {
      const healthCheckFn = vi.fn().mockResolvedValue({
        status: 'degraded' as const,
        message: 'High latency',
      });

      const inputModule: InputModule = {
        id: 'input-1',
        type: 'input',
        name: 'Test Input',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
        healthCheck: healthCheckFn,
      };

      await registry.register(inputModule);
      const health = await registry.checkHealth('input-1');
      expect(health).toEqual({
        status: 'degraded',
        version: '1.0.0',
        message: 'High latency',
      });
    });

    it('should return unhealthy when health check throws', async () => {
      const healthCheckFn = vi.fn().mockRejectedValue(new Error('Health check failed'));

      const inputModule: InputModule = {
        id: 'input-1',
        type: 'input',
        name: 'Test Input',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
        healthCheck: healthCheckFn,
      };

      await registry.register(inputModule);
      const health = await registry.checkHealth('input-1');
      expect(health).toEqual({
        status: 'unhealthy',
        version: '1.0.0',
        message: 'Health check failed',
      });
    });

    it('should return null for non-existent module', async () => {
      const health = await registry.checkHealth('non-existent');
      expect(health).toBeNull();
    });

    it('should get all health status', async () => {
      const healthCheckFn = vi.fn().mockResolvedValue({
        status: 'healthy' as const,
      });

      await registry.register({
        id: 'input-1',
        type: 'input',
        name: 'Input 1',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
        healthCheck: healthCheckFn,
      });

      await registry.register({
        id: 'input-2',
        type: 'input',
        name: 'Input 2',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
      });

      const allStatus = await registry.getAllHealthStatus();
      expect(allStatus.size).toBe(2);
      expect(allStatus.get('input-1')).toEqual({
        status: 'healthy',
        version: '1.0.0',
      });
      expect(allStatus.get('input-2')).toEqual({
        status: 'healthy',
        version: '1.0.0',
      });
    });
  });

  describe('registration errors', () => {
    it('should track registration errors', async () => {
      const moduleV1: InputModule = {
        id: 'input-1',
        type: 'input',
        name: 'Test Input',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
      };

      const moduleV2: InputModule = {
        id: 'input-1',
        type: 'input',
        name: 'Test Input',
        version: '2.0.0',
        handle: vi.fn().mockResolvedValue({}),
      };

      await registry.register(moduleV1);
      try {
        await registry.register(moduleV2);
      } catch (e) {
        // Expected
      }

      const errors = registry.getRegistrationErrors();
      expect(errors.size).toBe(1);
      expect(errors.get('input-1')?.message).toContain('version conflict');
    });

    it('should get specific registration error', async () => {
      const moduleV1: InputModule = {
        id: 'input-1',
        type: 'input',
        name: 'Test Input',
        version: '1.0.0',
        handle: vi.fn().mockResolvedValue({}),
      };

      const moduleV2: InputModule = {
        id: 'input-1',
        type: 'input',
        name: 'Test Input',
        version: '2.0.0',
        handle: vi.fn().mockResolvedValue({}),
      };

      await registry.register(moduleV1);
      try {
        await registry.register(moduleV2);
      } catch (e) {
        // Expected
      }

      const error = registry.getRegistrationError('input-1');
      expect(error).toBeDefined();
      expect(error?.message).toContain('version conflict');
    });
  });
});
