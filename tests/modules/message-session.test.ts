import { describe, it, expect } from 'vitest';

describe('Message Session Module', () => {
  describe('Uniqueness Check', () => {
    it('should have unique export names', async () => {
      const mod = await import('../../src/server/modules/message-session.js');
      const exports = Object.keys(mod);
      const uniqueExports = new Set(exports);
      expect(exports.length).toBe(uniqueExports.size);
    });
  });

  describe('Basic Functionality', () => {
    it('should export message session helpers', async () => {
      const mod = await import('../../src/server/modules/message-session.js');
      expect(mod).toBeDefined();
    });
  });
});
