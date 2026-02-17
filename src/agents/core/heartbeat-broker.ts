import dgram from 'dgram';
import EventEmitter from 'events';

const HEARTBEAT_PORT = 5522; // Separate from daemon HTTP port
const HEARTBEAT_INTERVAL_MS = 5000; // Master broadcasts every 5s
const MISSED_THRESHOLD = 3; // 3 misses = 15s timeout

export interface HeartbeatBrokerOptions {
  port?: number;
  intervalMs?: number;
  missedThreshold?: number;
}

/**
 * Master process heartbeat broadcaster
 * Sends UDP broadcast to all child agents
 */
export class HeartbeatBroker extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private interval: NodeJS.Timeout | null = null;
  private port: number;
  private intervalMs: number;
  private broadcastAddress: string;
  private sequence = 0;

  constructor(options: HeartbeatBrokerOptions = {}) {
    super();
    this.port = options.port || HEARTBEAT_PORT;
    this.intervalMs = options.intervalMs || HEARTBEAT_INTERVAL_MS;
    this.broadcastAddress = '255.255.255.255';
  }

  start(): void {
    if (this.socket) return;

    this.socket = dgram.createSocket('udp4');
    this.socket.bind(() => {
      this.socket?.setBroadcast(true);
      console.log(`[HeartbeatBroker] Broadcasting on port ${this.port}`);
    });

    this.interval = setInterval(() => {
      this.broadcast();
    }, this.intervalMs);
  }

  private broadcast(): void {
    if (!this.socket) return;

    const payload = JSON.stringify({
      type: 'master_heartbeat',
      sequence: ++this.sequence,
      timestamp: Date.now(),
      pid: process.pid,
    });

    const message = Buffer.from(payload);
    this.socket.send(message, 0, message.length, this.port, this.broadcastAddress, (err) => {
      if (err) {
        console.error('[HeartbeatBroker] Broadcast failed:', err.message);
      }
    });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    console.log('[HeartbeatBroker] Stopped');
  }
}

/**
 * Child process heartbeat monitor
 * Listens for master heartbeat, self-destructs if missed 3 times
 */
export class HeartbeatMonitor extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private missedCount = 0;
  private lastSequence = 0;
  private checkInterval: NodeJS.Timeout | null = null;
  private port: number;
  private missedThreshold: number;
  private intervalMs: number;

  constructor(options: HeartbeatBrokerOptions = {}) {
    super();
    this.port = options.port || HEARTBEAT_PORT;
    this.missedThreshold = options.missedThreshold || MISSED_THRESHOLD;
    this.intervalMs = options.intervalMs || HEARTBEAT_INTERVAL_MS;
  }

  start(onDeath: () => void): void {
    if (this.socket) return;

    this.socket = dgram.createSocket('udp4');

    this.socket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'master_heartbeat') {
          this.missedCount = 0;
          this.lastSequence = data.sequence;
          this.emit('heartbeat', data);
        }
      } catch {
        // Ignore invalid messages
      }
    });

    this.socket.bind(this.port, () => {
      console.log(`[HeartbeatMonitor] Listening on port ${this.port}`);
    });

    // Check every interval period if we received a heartbeat
    this.checkInterval = setInterval(() => {
      this.missedCount++;
      console.log(`[HeartbeatMonitor] Missed heartbeat ${this.missedCount}/${this.missedThreshold}`);

      if (this.missedCount >= this.missedThreshold) {
        console.error('[HeartbeatMonitor] Master appears dead, initiating self-destruct');
        this.stop();
        onDeath();
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}
