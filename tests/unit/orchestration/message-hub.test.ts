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
  });

  describe('registerOutput', () => {
    it('should register an output handler', () => {
      const handler = vi.fn().mockResolvedValue({ result: 'ok' });
      hub.registerOutput('output-1', handler);
      const outputs = hub.getOutputs();
      expect(outputs.length).toBe(1);
      expect(outputs[0].id).toBe('output-1');
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

    it('should sort routes by priority', () => {
      hub.addRoute({ pattern: 'low', handler: vi.fn(), blocking: false, priority: 1 });
      hub.addRoute({ pattern: 'high', handler: vi.fn(), blocking: false, priority: 10 });
      const routes = hub.getRoutes();
      expect(routes[0].priority).toBe(10);
      expect(routes[1].priority).toBe(1);
    });
  });

  describe('getInputs and getOutputs', () => {
    it('should return registered inputs and outputs', () => {
      hub.registerInput('input-1', vi.fn());
      hub.registerOutput('output-1', vi.fn().mockResolvedValue({}));
      
      expect(hub.getInputs().length).toBe(1);
      expect(hub.getOutputs().length).toBe(1);
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
});
