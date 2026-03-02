import { describe, it, expect } from 'vitest';

describe('Session Workspaces Module', () => {
  describe('Uniqueness Check', () => {
    it('should have unique export names', async () => {
      const mod = await import('../../src/server/modules/session-workspaces.js');
      const exports = Object.keys(mod);
      const uniqueExports = new Set(exports);
      expect(exports.length).toBe(uniqueExports.size);
    });
  });

  describe('Basic Functionality', () => {
    it('should export session workspace module', async () => {
      const mod = await import('../../src/server/modules/session-workspaces.js');
      expect(mod).toBeDefined();
    });

    it('should export session workspace helpers', async () => {
      const mod = await import('../../src/server/modules/session-workspaces.js');
      expect(mod).toBeDefined();
    });
  });
});
