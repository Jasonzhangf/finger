import { describe, it, expect, beforeEach } from 'vitest';
import { HubCore } from '../../../src/core/hub-core.js';
import { Registry } from '../../../src/core/registry-new.js';
import { createMessage } from '../../../src/core/schema.js';

describe('HubCore', () => {
  let hub: HubCore;
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
    hub = new HubCore(registry);
  });

  describe('registration', () => {
    it('registers input handlers', () => {
      hub.registerInput('cli', async () => ({ received: true }));
      
      expect(hub.getInputIds()).toContain('cli');
    });

    it('registers output handlers', () => {
      hub.registerOutput('log', async () => ({ logged: true }));
      
      expect(hub.getOutputIds()).toContain('log');
    });

    it('unregisters inputs', () => {
      hub.registerInput('test', async () => {});
      expect(hub.unregisterInput('test')).toBe(true);
      expect(hub.getInputIds()).not.toContain('test');
    });

    it('unregisters outputs', () => {
      hub.registerOutput('test', async () => {});
      expect(hub.unregisterOutput('test')).toBe(true);
      expect(hub.getOutputIds()).not.toContain('test');
    });
  });

  describe('routing', () => {
    it('routes message to matched output', async () => {
      registry.addRoute({
        id: 'r1',
        match: { type: 'command' },
        dest: ['log'],
        priority: 100
      });

      let received = false;
      hub.registerOutput('log', async (_msg) => {
        received = true;
        return { logged: true };
      });

      const msg = createMessage('command', { text: 'hello' }, 'cli');
      const results = await hub.route(msg);

      expect(received).toBe(true);
      expect(results).toHaveLength(1);
    });

    it('routes to multiple outputs', async () => {
      registry.addRoute({
        id: 'r1',
        match: { type: 'command' },
        dest: ['out1', 'out2'],
        priority: 100
      });

      const calls: string[] = [];
      hub.registerOutput('out1', async () => { calls.push('out1'); return {}; });
      hub.registerOutput('out2', async () => { calls.push('out2'); return {}; });

      const msg = createMessage('command', {}, 'cli');
      await hub.route(msg);

      expect(calls).toContain('out1');
      expect(calls).toContain('out2');
    });

    it('continues on output error', async () => {
      registry.addRoute({
        id: 'r1',
        match: { type: 'cmd' },
        dest: ['fail', 'success'],
        priority: 100
      });

      hub.registerOutput('fail', async () => { throw new Error('fail'); });
      hub.registerOutput('success', async () => ({ ok: true }));

      const msg = createMessage('cmd', {}, 'cli');
      const results = await hub.route(msg);

      expect(results).toHaveLength(2);
    });
  });

  describe('direct send', () => {
    it('sends message directly to output', async () => {
      hub.registerOutput('agent', async (_msg) => ({ processed: msg.payload }));

      const msg = createMessage('cmd', { action: 'run' }, 'cli');
      const result = await hub.sendTo('agent', msg);

      expect(result).toEqual({ processed: { action: 'run' } });
    });

    it('throws on missing output', async () => {
      const msg = createMessage('cmd', {}, 'cli');
      
      await expect(hub.sendTo('missing', msg)).rejects.toThrow('Output not found');
    });
  });
});
