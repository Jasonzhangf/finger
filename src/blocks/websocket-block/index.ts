import { WebSocketServer, type WebSocket } from 'ws';
import { BaseBlock, type BlockCapabilities } from '../../core/block.js';

export class WebSocketBlock extends BaseBlock {
  readonly type = 'websocket';
  readonly capabilities: BlockCapabilities = {
    functions: ['start', 'stop', 'broadcast', 'connections'],
    cli: [
      { name: 'start', description: 'Start WebSocket server', args: [] },
      { name: 'stop', description: 'Stop WebSocket server', args: [] },
      { name: 'broadcast', description: 'Broadcast message', args: [] }
    ],
    stateSchema: {
      running: { type: 'boolean', readonly: true, description: 'Server running state' },
      connections: { type: 'number', readonly: true, description: 'Active connections' }
    }
  };

  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();

  constructor(id: string) {
    super(id, 'websocket');
  }

  async execute(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'start':
        return this.startServer(args.port as number || 5522);
      case 'stop':
        return this.stopServer();
      case 'broadcast':
        return this.broadcast(args.message as string);
      case 'connections':
        return { connections: this.clients.size };
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  startServer(port = 5522): { started: boolean; port: number } {
    if (this.wss) return { started: false, port };

    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      this.syncState();

      ws.on('close', () => {
        this.clients.delete(ws);
        this.syncState();
      });
    });

    this.syncState(true);
    return { started: true, port };
  }

  stopServer(): { stopped: boolean } {
    if (!this.wss) return { stopped: false };

    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.wss.close();
    this.wss = null;
    this.syncState(false);

    return { stopped: true };
  }

  broadcast(message: string): { sent: number } {
    let sent = 0;
    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(message);
        sent += 1;
      }
    }
    return { sent };
  }

  private syncState(running = this.wss !== null): void {
    this.updateState({
      data: {
        running,
        connections: this.clients.size
      }
    });
  }
}
