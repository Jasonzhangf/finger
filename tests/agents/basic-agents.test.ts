import { describe, it, expect } from 'vitest';

describe('Agents Basic Tests', () => {
  describe('Uniqueness Check', () => {
    it('should have unique exports in kernel-agent-base', async () => {
      const mod = await import('../../src/agents/base/kernel-agent-base.js');
      const exports = Object.keys(mod);
      const uniqueExports = new Set(exports);
      expect(exports.length).toBe(uniqueExports.size);
    });

    it('should have unique exports in chat-codex-module', async () => {
      const mod = await import('../../src/agents/chat-codex/chat-codex-module.js');
      const exports = Object.keys(mod);
      const uniqueExports = new Set(exports);
      expect(exports.length).toBe(uniqueExports.size);
    });
  });

  describe('Basic Functionality', () => {
    it('should export KernelAgentBase class', async () => {
      const mod = await import('../../src/agents/base/kernel-agent-base.js');
      expect(mod.KernelAgentBase).toBeDefined();
    });

    it('should export chat codex module', async () => {
      const mod = await import('../../src/agents/chat-codex/chat-codex-module.js');
      expect(mod).toBeDefined();
    });
  });
});
