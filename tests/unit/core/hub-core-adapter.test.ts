import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HubCoreAdapter, createHubCoreAdapter } from '../../../src/core/hub-core-adapter.js';
import type { Message } from '../../../src/core/schema.js';

describe('HubCoreAdapter', () => {
  let adapter: HubCoreAdapter;

  beforeEach(() => {
    adapter = createHubCoreAdapter();
  });

  describe('register/unregister', () => {
    it('should register input handler', () => {
      const handler = vi.fn().mockResolvedValue({});
      adapter.registerInput('input-1', handler);
      expect(adapter.getInputIds()).toContain('input-1');
    });

    it('should register output handler', () => {
      const handler = vi.fn().mockResolvedValue({});
      adapter.registerOutput('output-1', handler);
      expect(adapter.getOutputIds()).toContain('output-1');
    });

    it('should unregister input handler', () => {
      const handler = vi.fn();
      adapter.registerInput('input-1', handler);
      const result = adapter.unregisterInput('input-1');
      expect(result).toBe(true);
      expect(adapter.getInputIds()).not.toContain('input-1');
    });

    it('should unregister output handler', () => {
      const handler = vi.fn();
      adapter.registerOutput('output-1', handler);
      const result = adapter.unregisterOutput('output-1');
      expect(result).toBe(true);
      expect(adapter.getOutputIds()).not.toContain('output-1');
    });

    it('should return false when unregistering non-existent input', () => {
      const result = adapter.unregisterInput('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('sendTo', () => {
    it('should send message to specific output', async () => {
      const handler = vi.fn().mockResolvedValue({ result: 'ok' });
      adapter.registerOutput('output-1', handler);

      const message: Message = {
        id: 'msg-1',
        type: 'test',
        payload: { data: 'test' },
        meta: { source: 'test' },
      };

      const result = await adapter.sendTo('output-1', message);
      expect(handler).toHaveBeenCalledWith(message);
      expect(result).toEqual({ result: 'ok' });
    });

    it('should throw when sending to non-existent output', async () => {
      const message: Message = {
        id: 'msg-1',
        type: 'test',
        payload: {},
        meta: {},
      };

      await expect(adapter.sendTo('non-existent', message)).rejects.toThrow();
    });
  });

  describe('route', () => {
    it('should route message to all outputs', async () => {
      const handler1 = vi.fn().mockResolvedValue({ output: '1' });
      const handler2 = vi.fn().mockResolvedValue({ output: '2' });

      adapter.registerOutput('output-1', handler1);
      adapter.registerOutput('output-2', handler2);

      const message: Message = {
        id: 'msg-1',
        type: 'test',
        payload: { data: 'test' },
        meta: {},
      };

      const results = await adapter.route(message);
      expect(results).toHaveLength(2);
      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('should handle errors in outputs', async () => {
      const handler1 = vi.fn().mockResolvedValue({ output: '1' });
      const handler2 = vi.fn().mockRejectedValue(new Error('Output error'));

      adapter.registerOutput('output-1', handler1);
      adapter.registerOutput('output-2', handler2);

      const message: Message = {
        id: 'msg-1',
        type: 'test',
        payload: {},
        meta: {},
      };

      const results = await adapter.route(message);
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ output: '1' });
      expect(results[1]).toMatchObject({
        error: 'Error: Output error',
        dest: 'output-2',
      });
    });
  });

  describe('getMessageHub', () => {
    it('should return underlying MessageHub instance', () => {
      const hub = adapter.getMessageHub();
      expect(hub).toBeDefined();
      expect(typeof hub.addRoute).toBe('function');
      expect(typeof hub.routeToOutput).toBe('function');
    });
  });

  describe('destroy', () => {
    it('should clear all handlers', () => {
      const handler = vi.fn();
      adapter.registerInput('input-1', handler);
      adapter.registerOutput('output-1', handler);

      adapter.destroy();

      expect(adapter.getInputIds()).toHaveLength(0);
      expect(adapter.getOutputIds()).toHaveLength(0);
    });
  });
});
