import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebSocketBlock } from '../../../src/blocks/websocket-block/index.js';

const mockClient = {
  readyState: 1,
  send: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
};

const mockWss = {
  on: vi.fn(),
  close: vi.fn((cb) => cb && cb()),
};

vi.mock('ws', () => ({
  WebSocketServer: vi.fn().mockImplementation(() => mockWss),
  WebSocket: vi.fn().mockImplementation(() => mockClient),
}));

describe('WebSocketBlock', () => {
  let block: WebSocketBlock;

  beforeEach(() => {
    vi.clearAllMocks();
    block = new WebSocketBlock('test-ws');
  });

  describe('constructor', () => {
    it('should initialize with id and type', () => {
      expect(block.id).toBe('test-ws');
      expect(block.type).toBe('websocket');
    });

    it('should have all required capabilities', () => {
      const caps = block.capabilities;
      expect(caps.functions).toContain('start');
      expect(caps.functions).toContain('stop');
      expect(caps.functions).toContain('broadcast');
      expect(caps.functions).toContain('connections');
    });
  });

  describe('execute - start', () => {
    it('should start WebSocket server', async () => {
      const result = await block.execute('start', { port: 8081 });
      expect(result.started).toBe(true);
      expect(result.port).toBe(8081);
    });

    it('should return started false if already running', async () => {
      block.startServer(8081);
      const result = await block.execute('start', { port: 8082 });
      expect(result.started).toBe(false);
    });
  });

  describe('execute - stop', () => {
    it('should stop WebSocket server', async () => {
      block.startServer(8081);
      const result = await block.execute('stop', {});
      expect(result.stopped).toBe(true);
    });

    it('should return stopped false if not running', async () => {
      const result = await block.execute('stop', {});
      expect(result.stopped).toBe(false);
    });
  });

  describe('execute - broadcast', () => {
    it('should broadcast message to clients', async () => {
      block.startServer(8081);
      const result = await block.execute('broadcast', { message: 'test' });
      expect(result.sent).toBe(0);
    });
  });

  describe('execute - connections', () => {
    it('should return connection count', async () => {
      const result = await block.execute('connections', {});
      expect(result.connections).toBe(0);
    });
  });

  describe('execute - unknown command', () => {
    it('should throw for unknown command', async () => {
      await expect(block.execute('unknown', {})).rejects.toThrow('Unknown command');
    });
  });
});
