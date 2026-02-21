import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketBlock } from '../../../src/blocks/websocket-block/index.js';

type MockSocket = {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
};

const closeHandlers = new Map<MockSocket, () => void>();

function createSocket(readyState = 1): MockSocket {
  const socket: MockSocket = {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'close') {
        closeHandlers.set(socket, handler);
      }
    }),
  };
  return socket;
}

let connectionHandler: ((ws: MockSocket) => void) | null = null;

const mockWss = {
  on: vi.fn((event: string, handler: (ws: MockSocket) => void) => {
    if (event === 'connection') {
      connectionHandler = handler;
    }
  }),
  close: vi.fn((cb) => cb && cb()),
};

vi.mock('ws', () => ({
  WebSocketServer: vi.fn().mockImplementation(() => mockWss),
  WebSocket: vi.fn().mockImplementation(() => createSocket(1)),
}));

describe('WebSocketBlock', () => {
  let block: WebSocketBlock;

  beforeEach(() => {
    vi.clearAllMocks();
    closeHandlers.clear();
    connectionHandler = null;
    block = new WebSocketBlock('test-ws');
  });

  afterEach(() => {
    closeHandlers.clear();
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

    it('should send only to open clients', async () => {
      block.startServer(8081);
      expect(connectionHandler).toBeTruthy();

      const openSocket = createSocket(1);
      const closedSocket = createSocket(3);
      connectionHandler?.(openSocket);
      connectionHandler?.(closedSocket);

      const result = await block.execute('broadcast', { message: 'hello' });

      expect(result.sent).toBe(1);
      expect(openSocket.send).toHaveBeenCalledWith('hello');
      expect(closedSocket.send).not.toHaveBeenCalled();
    });
  });

  describe('connection lifecycle', () => {
    it('should track connection and close events', async () => {
      block.startServer(8081);
      expect(connectionHandler).toBeTruthy();

      const socket = createSocket(1);
      connectionHandler?.(socket);

      const afterConnect = await block.execute('connections', {});
      expect(afterConnect.connections).toBe(1);

      closeHandlers.get(socket)?.();

      const afterClose = await block.execute('connections', {});
      expect(afterClose.connections).toBe(0);
    });

    it('should close all clients on stop', async () => {
      block.startServer(8081);
      expect(connectionHandler).toBeTruthy();

      const socket1 = createSocket(1);
      const socket2 = createSocket(1);
      connectionHandler?.(socket1);
      connectionHandler?.(socket2);

      const result = await block.execute('stop', {});

      expect(result.stopped).toBe(true);
      expect(socket1.close).toHaveBeenCalledTimes(1);
      expect(socket2.close).toHaveBeenCalledTimes(1);
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
