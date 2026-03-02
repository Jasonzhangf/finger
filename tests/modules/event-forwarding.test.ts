import { describe, it, expect } from 'vitest';

describe('Event Forwarding Module', () => {
  describe('Uniqueness Check', () => {
    it('should have unique export names', async () => {
      const mod = await import('../../src/server/modules/event-forwarding.js');
      const exports = Object.keys(mod);
      const uniqueExports = new Set(exports);
      expect(exports.length).toBe(uniqueExports.size);
    });
  });

  describe('Basic Functionality', () => {
    it('should export attachEventForwarding function', async () => {
      const mod = await import('../../src/server/modules/event-forwarding.js');
      expect(typeof mod.attachEventForwarding).toBe('function');
    });
  });
});
