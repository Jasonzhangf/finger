import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageHub } from '../../../src/orchestration/message-hub.js';

describe('MessageHub', () => {
  let hub: MessageHub;

  beforeEach(() => {
    vi.clearAllMocks();
    hub = new MessageHub();
  });

  describe('registerInput', () => {
    it('should register an input handler', () => {
      const handler = vi.fn();
      hub.registerInput('input-1', handler);
      const inputs = hub.getInputs();
      expect(inputs.length).toBe(1);
      expect(inputs[0].id).toBe('input-1');
    });

    it('should register input with routes', () => {
      const handler = vi.fn();
      hub.registerInput('input-1', handler, ['output-1', 'output-2']);
      const inputs = hub.getInputs();
      expect(inputs[0].routes).toEqual(['output-1', 'output-2']);
    });

    it('should overwrite existing input', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      hub.registerInput('input-1', handler1);
      hub.registerInput('input-1', handler2);
      expect(hub.getInputs().length).toBe(1);
    });
  });

  describe('registerOutput', () => {
    it('should register an output handler', () => {
      const handler = vi.fn().mockResolvedValue({ result: 'ok' });
      hub.registerOutput('output-1', handler);
      const outputs = hub.getOutputs();
      expect(outputs.length).toBe(1);
      expect(outputs[0].id).toBe('output-1');
    });

    it('should overwrite existing output', () => {
      const handler1 = vi.fn().mockResolvedValue({});
      const handler2 = vi.fn().mockResolvedValue({});
      hub.registerOutput('output-1', handler1);
      hub.registerOutput('output-1', handler2);
      expect(hub.getOutputs().length).toBe(1);
    });
  });

  describe('addRoute', () => {
    it('should add a route with string pattern', () => {
      const handler = vi.fn();
      const routeId = hub.addRoute({ pattern: 'test.message', handler, blocking: false, priority: 1 });
      expect(routeId).toBeDefined();
      const routes = hub.getRoutes();
      expect(routes.length).toBe(1);
      expect(routes[0].pattern).toBe('test.message');
    });

    it('should add a route with custom id', () => {
      const handler = vi.fn();
      const routeId = hub.addRoute({ id: 'custom-id', pattern: 'test', handler, blocking: false, priority: 0 });
      expect(routeId).toBe('custom-id');
    });

    it('should add a route with RegExp pattern', () => {
      const handler = vi.fn();
      hub.addRoute({ pattern: /^test\..*$/, handler, blocking: false, priority: 0 });
      const routes = hub.getRoutes();
      expect(routes[0].pattern).toBeInstanceOf(RegExp);
    });

    it('should add a route with function pattern', () => {
      const handler = vi.fn();
      const matcher = (msg: any) => msg.type === 'custom';
      hub.addRoute({ pattern: matcher, handler, blocking: false, priority: 0 });
      const routes = hub.getRoutes();
      expect(typeof routes[0].pattern).toBe('function');
    });

    it('should sort routes by priority', () => {
      hub.addRoute({ pattern: 'low', handler: vi.fn(), blocking: false, priority: 1 });
      hub.addRoute({ pattern: 'high', handler: vi.fn(), blocking: false, priority: 10 });
      hub.addRoute({ pattern: 'mid', handler: vi.fn(), blocking: false, priority: 5 });
      const routes = hub.getRoutes();
      expect(routes[0].priority).toBe(10);
      expect(routes[1].priority).toBe(5);
      expect(routes[2].priority).toBe(1);
    });

    it('should store route description', () => {
      hub.addRoute({ pattern: 'test', handler: vi.fn(), blocking: false, priority: 0, description: 'Test route' });
      const routes = hub.getRoutes();
      expect(routes[0].description).toBe('Test route');
    });
  });

  describe('removeRoute', () => {
    it('should remove existing route', () => {
      const routeId = hub.addRoute({ pattern: 'test', handler: vi.fn(), blocking: false, priority: 0 });
      const removed = hub.removeRoute(routeId);
      expect(removed).toBe(true);
      expect(hub.getRoutes().length).toBe(0);
    });

    it('should return false for non-existent route', () => {
      const removed = hub.removeRoute('non-existent');
      expect(removed).toBe(false);
    });
  });

  describe('getInputs and getOutputs', () => {
    it('should return registered inputs and outputs', () => {
      hub.registerInput('input-1', vi.fn());
      hub.registerOutput('output-1', vi.fn().mockResolvedValue({}));
      
      expect(hub.getInputs().length).toBe(1);
      expect(hub.getOutputs().length).toBe(1);
    });

    it('should return empty arrays when nothing registered', () => {
      expect(hub.getInputs()).toEqual([]);
      expect(hub.getOutputs()).toEqual([]);
    });
  });

  describe('send', () => {
    it('should route message to matching handler', async () => {
      const handler = vi.fn().mockResolvedValue({ result: 'ok' });
      hub.addRoute({ pattern: 'test.type', handler, blocking: false, priority: 0 });
      
      await hub.send({ type: 'test.type', data: 'hello' });
      
      expect(handler).toHaveBeenCalledWith({ type: 'test.type', data: 'hello' });
    });

    it('should route by message.route', async () => {
      const handler = vi.fn().mockResolvedValue({});
      hub.addRoute({ pattern: 'custom-route', handler, blocking: false, priority: 0 });
      
      await hub.send({ route: 'custom-route' });
      
      expect(handler).toHaveBeenCalled();
    });

    it('should return result from blocking route', async () => {
      const handler = vi.fn().mockResolvedValue({ value: 42 });
      hub.addRoute({ pattern: 'test', handler, blocking: true, priority: 0 });
      
      const result = await hub.send({ type: 'test' });
      
      expect(result).toEqual({ value: 42 });
    });

    it('should queue message when no matching route', async () => {
      await hub.send({ type: 'no-match' });
      
      expect(hub.getQueueLength()).toBe(1);
    });

    it('should call callback with result', async () => {
      const handler = vi.fn().mockResolvedValue({ result: 'ok' });
      const callback = vi.fn();
      hub.addRoute({ pattern: 'test', handler, blocking: false, priority: 0 });
      
      await hub.send({ type: 'test' }, callback);
      
      expect(callback).toHaveBeenCalledWith({ result: 'ok' });
    });

    it('should match RegExp pattern', async () => {
      const handler = vi.fn().mockResolvedValue({});
      // RegExp tests against JSON.stringify of message
      hub.addRoute({ pattern: /"type":"api\./, handler, blocking: false, priority: 0 });
      
      await hub.send({ type: 'api.users' });
      
      // Handler should be called for matching RegExp
      expect(handler).toHaveBeenCalled();
    });

    it('should not match RegExp pattern when no match', async () => {
      const handler = vi.fn().mockResolvedValue({});
      // RegExp tests against JSON.stringify of message
      hub.addRoute({ pattern: /"type":"api\./, handler, blocking: false, priority: 0 });
      
      await hub.send({ type: 'web.users' });
      
      expect(handler).not.toHaveBeenCalled();
    });

    it('should match function pattern', async () => {
      const handler = vi.fn().mockResolvedValue({});
      hub.addRoute({ 
        pattern: (msg: any) => msg.priority > 5, 
        handler, 
        blocking: false, 
        priority: 0 
      });
      
      await hub.send({ priority: 10 });
      
      expect(handler).toHaveBeenCalled();
    });

    it('should call multiple non-blocking routes', async () => {
      const handler1 = vi.fn().mockResolvedValue({});
      const handler2 = vi.fn().mockResolvedValue({});
      hub.addRoute({ pattern: 'test', handler: handler1, blocking: false, priority: 0 });
      hub.addRoute({ pattern: 'test', handler: handler2, blocking: false, priority: 0 });
      
      await hub.send({ type: 'test' });
      
      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('should throw from blocking route on error', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Handler error'));
      hub.addRoute({ pattern: 'test', handler, blocking: true, priority: 0 });
      
      await expect(hub.send({ type: 'test' })).rejects.toThrow('Handler error');
    });

    it('should not throw from non-blocking route on error', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Handler error'));
      hub.addRoute({ pattern: 'test', handler, blocking: false, priority: 0 });
      
      // Should not throw
      await hub.send({ type: 'test' });
    });
  });

  describe('routeToOutput', () => {
    it('should route to registered output', async () => {
      const handler = vi.fn().mockResolvedValue({ output: 'result' });
      hub.registerOutput('output-1', handler);
      
      const result = await hub.routeToOutput('output-1', { data: 'test' });
      
      expect(result).toEqual({ output: 'result' });
    });

    it('should throw for non-existent output', async () => {
      await expect(hub.routeToOutput('non-existent', {})).rejects.toThrow('not registered');
    });

    it('should pass callback to handler', async () => {
      const handler = vi.fn().mockResolvedValue({});
      hub.registerOutput('output-1', handler);
      
      const callback = vi.fn();
      await hub.routeToOutput('output-1', { data: 'test' }, callback);
      
      // Handler receives message with _callbackId added
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][1]).toBe(callback);
    });
  });

  describe('sendToModule', () => {
    it('should send to input module', async () => {
      const handler = vi.fn().mockResolvedValue({ result: 'from-input' });
      hub.registerInput('module-1', handler, []);
      const result = await hub.sendToModule('module-1', { data: 'test' });
      expect(result).toEqual({ result: 'from-input' });
    });

    it('should send to output module', async () => {
      const handler = vi.fn().mockResolvedValue({ result: 'from-output' });
      hub.registerOutput('module-1', handler);
      const result = await hub.sendToModule('module-1', { data: 'test' });
      expect(result).toEqual({ result: 'from-output' });
    });

    it('should throw for non-existent module', async () => {
      await expect(hub.sendToModule('non-existent', {})).rejects.toThrow('not registered');
    });

    it('should call callback for input module', async () => {
      const handler = vi.fn().mockResolvedValue({ result: 'ok' });
      hub.registerInput('input-1', handler);
      
      const callback = vi.fn();
      await hub.sendToModule('input-1', { data: 'test' }, callback);
      
      expect(callback).toHaveBeenCalledWith({ result: 'ok' });
    });
  });

  describe('processQueue', () => {
    it('should process queued messages', async () => {
      const handler = vi.fn().mockResolvedValue({});
      
      // First send without route - will queue
      await hub.send({ type: 'test' });
      expect(hub.getQueueLength()).toBe(1);
      
      // Add route
      hub.addRoute({ pattern: 'test', handler, blocking: false, priority: 0 });
      
      // Process queue
      const processed = hub.processQueue();
      
      expect(processed).toBe(1);
      expect(hub.getQueueLength()).toBe(0);
      expect(handler).toHaveBeenCalled();
    });

    it('should return 0 when queue is empty', () => {
      expect(hub.processQueue()).toBe(0);
    });
  });

  describe('executeCallback', () => {
    it('should execute pending callback', () => {
      const callback = vi.fn();
      hub.registerOutput('output-1', async (msg, cb) => {
        if (cb) cb({ result: 'ok' });
        return {};
      });
      
      // Manually add callback
      (hub as any).pendingCallbacks.set('cb-1', callback);
      
      const result = hub.executeCallback('cb-1', { result: 'test' });
      
      expect(result).toBe(true);
      expect(callback).toHaveBeenCalledWith({ result: 'test' });
    });

    it('should return false for non-existent callback', () => {
      const result = hub.executeCallback('non-existent', {});
      expect(result).toBe(false);
    });

    it('should delete callback after execution', () => {
      const callback = vi.fn();
      (hub as any).pendingCallbacks.set('cb-1', callback);
      
      hub.executeCallback('cb-1', {});
      hub.executeCallback('cb-1', {});
      
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe('reset', () => {
    it('should clear all registrations', () => {
      hub.registerInput('input-1', vi.fn());
      hub.registerOutput('output-1', vi.fn().mockResolvedValue({}));
      hub.addRoute({ pattern: 'test', handler: vi.fn(), blocking: false, priority: 0 });
      
      hub.reset();
      
      expect(hub.getInputs()).toEqual([]);
      expect(hub.getOutputs()).toEqual([]);
      expect(hub.getRoutes()).toEqual([]);
    });

    it('should clear message queue', async () => {
      await hub.send({ type: 'no-match' });
      expect(hub.getQueueLength()).toBe(1);
      
      hub.reset();
      
      expect(hub.getQueueLength()).toBe(0);
    });
  });

  describe('getQueueLength', () => {
    it('should return 0 for empty queue', () => {
      expect(hub.getQueueLength()).toBe(0);
    });

    it('should return correct queue length', async () => {
      await hub.send({ type: 'test1' });
      await hub.send({ type: 'test2' });
      
      expect(hub.getQueueLength()).toBe(2);
    });
  });
});
