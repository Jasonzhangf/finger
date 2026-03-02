import { describe, it, expect } from 'vitest';

// Test WebSocket server basic functionality
describe('WebSocket Server Module', () => {
  describe('Uniqueness Check', () => {
    it('should have unique export names in websocket-server module', async () => {
      const mod = await import('../../src/server/modules/websocket-server.js');
      const exports = Object.keys(mod);
      const uniqueExports = new Set(exports);
      expect(exports.length).toBe(uniqueExports.size);
    });

    it('should not duplicate exports with other modules', async () => {
      const wsMod = await import('../../src/server/modules/websocket-server.js');
      const sessionMod = await import('../../src/server/modules/session-workspaces.js');

      const wsExports = new Set(Object.keys(wsMod));
      const sessionExports = new Set(Object.keys(sessionMod));

      const overlap = [...wsExports].filter(e => sessionExports.has(e));
      const internalOverlap = overlap.filter(e => !['default'].includes(e));
      expect(internalOverlap).toHaveLength(0);
    });
  });

  describe('Basic Functionality', () => {
    it('should export createWebSocketServer function', async () => {
      const mod = await import('../../src/server/modules/websocket-server.js');
      expect(typeof mod.createWebSocketServer).toBe('function');
    });
  });
});
