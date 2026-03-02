import { describe, it, expect } from 'vitest';

describe('Orchestration Basic Tests', () => {
  describe('Uniqueness Check', () => {
    it('should have unique exports in agent-pool', async () => {
      const mod = await import('../../src/orchestration/agent-pool.js');
      const exports = Object.keys(mod);
      const uniqueExports = new Set(exports);
      expect(exports.length).toBe(uniqueExports.size);
    });

    it('should have unique exports in module-registry', async () => {
      const mod = await import('../../src/orchestration/module-registry.js');
      const exports = Object.keys(mod);
      const uniqueExports = new Set(exports);
      expect(exports.length).toBe(uniqueExports.size);
    });

    it('should have unique exports in resource-pool', async () => {
      const mod = await import('../../src/orchestration/resource-pool.js');
      const exports = Object.keys(mod);
      const uniqueExports = new Set(exports);
      expect(exports.length).toBe(uniqueExports.size);
    });
  });

  describe('Basic Functionality', () => {
    it('should export AgentPool class', async () => {
      const mod = await import('../../src/orchestration/agent-pool.js');
      expect(mod.AgentPool).toBeDefined();
    });

    it('should export ModuleRegistry class', async () => {
      const mod = await import('../../src/orchestration/module-registry.js');
      expect(mod.ModuleRegistry).toBeDefined();
    });

    it('should export ResourcePool class', async () => {
      const mod = await import('../../src/orchestration/resource-pool.js');
      expect(mod.ResourcePool).toBeDefined();
    });
  });
});
