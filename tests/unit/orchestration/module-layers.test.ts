import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks
const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('fs', () => fsMocks);

vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/test'),
}));

vi.mock('../../../src/core/logger.js', () => ({
  logger: {
    module: vi.fn(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

// Import after mocks
import {
  ModuleLayersManager,
  moduleLayers,
  type ModuleLayersConfig,
} from '../../../src/orchestration/module-layers.js';

const mockConfig: ModuleLayersConfig = {
  version: 1,
  description: 'Test module layers config',
  layers: {
    core: {
      description: 'Core modules',
      upgradePolicy: 'full',
      requiresRestart: true,
      modules: ['kernel', 'agent-runtime-block', 'message-hub'],
      paths: ['src/blocks/*', 'src/core/*'],
    },
    extension: {
      description: 'Extension modules',
      upgradePolicy: 'hot',
      requiresRestart: false,
      modules: ['finger-ui', 'finger-tool', 'custom-*'],
      paths: ['src/extensions/*'],
    },
  },
  dependencies: {
    'finger-ui': ['kernel'],
    'finger-tool': ['kernel', 'message-hub'],
    'custom-agent': ['finger-tool'],
  },
  upgradeTriggers: {
    default: 'auto',
    options: ['auto', 'manual', 'scheduled'],
  },
  rollback: {
    maxPoints: 3,
    storagePath: '~/.finger/rollback',
  },
};

describe('ModuleLayersManager', () => {
  let manager: ModuleLayersManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new ModuleLayersManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('load()', () => {
    it('should load config successfully when file exists', async () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(JSON.stringify(mockConfig));

      const config = await manager.load('/test/module-layers.json');

      expect(config).toEqual(mockConfig);
      expect(config.layers.core.modules).toContain('kernel');
      expect(config.layers.extension.modules).toContain('finger-ui');
    });

    it('should throw error when config file does not exist', async () => {
      fsMocks.existsSync.mockReturnValue(false);

      await expect(manager.load('/nonexistent/config.json')).rejects.toThrow(
        'Module layers config not found',
      );
    });

    it('should throw error when config file has invalid JSON', async () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue('not valid json {{{');

      await expect(manager.load('/test/invalid.json')).rejects.toThrow(
        'Failed to parse module-layers.json',
      );
    });

    it('should return cached config on second load', async () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(JSON.stringify(mockConfig));

      await manager.load('/test/config.json');
      // Second load should use cache
      const config2 = await manager.load('/test/config.json');

      expect(fsMocks.readFileSync).toHaveBeenCalledTimes(1);
      expect(config2).toEqual(mockConfig);
    });
  });

  describe('getConfig()', () => {
    it('should return config after load', async () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(JSON.stringify(mockConfig));

      await manager.load('/test/config.json');
      const config = manager.getConfig();

      expect(config.version).toBe(1);
      expect(config.layers.core).toBeDefined();
      expect(config.layers.extension).toBeDefined();
    });

    it('should throw when called before load', () => {
      expect(() => manager.getConfig()).toThrow('Module layers not loaded');
    });
  });

  describe('getModuleTier()', () => {
    beforeEach(async () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(JSON.stringify(mockConfig));
      await manager.load('/test/config.json');
    });

    it('should return "core" for core modules', () => {
      expect(manager.getModuleTier('kernel')).toBe('core');
      expect(manager.getModuleTier('agent-runtime-block')).toBe('core');
      expect(manager.getModuleTier('message-hub')).toBe('core');
    });

    it('should return "extension" for extension modules', () => {
      expect(manager.getModuleTier('finger-ui')).toBe('extension');
      expect(manager.getModuleTier('finger-tool')).toBe('extension');
    });

    it('should support wildcard patterns for extension modules', () => {
      expect(manager.getModuleTier('custom-agent')).toBe('extension');
      expect(manager.getModuleTier('custom-xyz')).toBe('extension');
    });

    it('should return "unknown" for unknown modules', () => {
      expect(manager.getModuleTier('nonexistent-module')).toBe('unknown');
      expect(manager.getModuleTier('random-thing')).toBe('unknown');
    });

    it('should cache tier results', () => {
      // First call
      manager.getModuleTier('kernel');
      // Second call should use cache (no new lookups)
      manager.getModuleTier('kernel');

      // Both calls return 'core'
      expect(manager.getModuleTier('kernel')).toBe('core');
    });
  });

  describe('getUpgradePolicy()', () => {
    beforeEach(async () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(JSON.stringify(mockConfig));
      await manager.load('/test/config.json');
    });

    it('should return full upgrade policy for core modules', () => {
      const policy = manager.getUpgradePolicy('kernel');
      expect(policy.type).toBe('full');
      expect(policy.requiresRestart).toBe(true);
    });

    it('should return hot upgrade policy for extension modules', () => {
      const policy = manager.getUpgradePolicy('finger-ui');
      expect(policy.type).toBe('hot');
      expect(policy.requiresRestart).toBe(false);
    });

    it('should return unknown for unknown modules', () => {
      const policy = manager.getUpgradePolicy('unknown-module');
      expect(policy.type).toBe('unknown');
      expect(policy.requiresRestart).toBe(false);
    });
  });

  describe('getDependencies()', () => {
    beforeEach(async () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(JSON.stringify(mockConfig));
      await manager.load('/test/config.json');
    });

    it('should return dependencies for a module', () => {
      expect(manager.getDependencies('finger-ui')).toEqual(['kernel']);
      expect(manager.getDependencies('finger-tool')).toEqual(['kernel', 'message-hub']);
    });

    it('should return empty array for modules without dependencies', () => {
      expect(manager.getDependencies('kernel')).toEqual([]);
      expect(manager.getDependencies('nonexistent')).toEqual([]);
    });
  });

  describe('validateDependencies()', () => {
    beforeEach(async () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(JSON.stringify(mockConfig));
      await manager.load('/test/config.json');
    });

    it('should return ok when all dependencies are satisfied', () => {
      const result = manager.validateDependencies('finger-ui');
      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('should return ok when all nested dependencies are known', () => {
      const result = manager.validateDependencies('custom-agent');
      // custom-agent -> finger-tool (extension, known)
      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('should detect missing dependency when dep module is unknown', async () => {
      // Create a new manager with a config that has missing dependencies
      const configWithMissingDeps: ModuleLayersConfig = {
        ...mockConfig,
        dependencies: {
          'my-module': ['nonexistent-dep', 'another-missing'],
        },
      };
      const missingManager = new ModuleLayersManager();
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(JSON.stringify(configWithMissingDeps));
      await missingManager.load('/test/config.json');

      const result = missingManager.validateDependencies('my-module');
      expect(result.ok).toBe(false);
      expect(result.missing).toEqual(['nonexistent-dep', 'another-missing']);
    });
  });

  describe('resolveDependencyOrder()', () => {
    beforeEach(async () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(JSON.stringify(mockConfig));
      await manager.load('/test/config.json');
    });

    it('should resolve correct dependency order', () => {
      // custom-agent -> finger-tool -> kernel, message-hub
      const order = manager.resolveDependencyOrder('custom-agent');

      // Dependencies should come before dependents
      expect(order.indexOf('kernel')).toBeLessThan(order.indexOf('finger-tool'));
      expect(order.indexOf('message-hub')).toBeLessThan(order.indexOf('finger-tool'));
      expect(order.indexOf('finger-tool')).toBeLessThan(order.indexOf('custom-agent'));
    });

    it('should handle modules without dependencies', () => {
      const order = manager.resolveDependencyOrder('kernel');
      expect(order).toEqual(['kernel']);
    });

    it('should handle single dependency', () => {
      const order = manager.resolveDependencyOrder('finger-ui');
      expect(order).toEqual(['kernel', 'finger-ui']);
    });
  });

  describe('affectsCoreLayer()', () => {
    beforeEach(async () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(JSON.stringify(mockConfig));
      await manager.load('/test/config.json');
    });

    it('should return true when path matches core paths', () => {
      expect(manager.affectsCoreLayer(['src/blocks/agent-runtime-block/index.ts'])).toBe(true);
      expect(manager.affectsCoreLayer(['src/core/logger/index.ts'])).toBe(true);
    });

    it('should return false when path does not match core paths', () => {
      expect(manager.affectsCoreLayer(['src/extensions/custom/index.ts'])).toBe(false);
      expect(manager.affectsCoreLayer(['tests/unit/test.ts'])).toBe(false);
    });

    it('should handle multiple paths where at least one is core', () => {
      const result = manager.affectsCoreLayer([
        'src/extensions/custom/index.ts',
        'src/blocks/kernel/index.ts',
      ]);
      expect(result).toBe(true);
    });
  });
});

describe('moduleLayers singleton', () => {
  it('should export a singleton instance', () => {
    expect(moduleLayers).toBeInstanceOf(ModuleLayersManager);
  });
});
