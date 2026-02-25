import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { createInterface } from 'readline';
import { GatewayAckEnvelope, GatewayDeliveryMode, GatewayEventEnvelope, GatewayInboundEnvelope, GatewayOutboundEnvelope, GatewayRequestEnvelope, GatewayResultEnvelope, ResolvedGatewayModule } from './types.js';

const DEFAULT_ACK_TIMEOUT_MS = 3000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

interface PendingAck {
  resolve: (value: GatewayAckEnvelope) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingResult {
  resolve: (value: GatewayResultEnvelope) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface GatewayProcessSessionOptions {
  module: ResolvedGatewayModule;
  onInbound?: (inbound: GatewayInboundEnvelope) => Promise<void>;
  onEvent?: (event: GatewayEventEnvelope) => Promise<void>;
}

export class GatewayProcessSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private started = false;
  private requestSeq = 1;
  private pendingAck = new Map<string, PendingAck>();
  private pendingResult = new Map<string, PendingResult>();
  private readonly module: ResolvedGatewayModule;
  private readonly onInbound?: (inbound: GatewayInboundEnvelope) => Promise<void>;
  private readonly onEvent?: (event: GatewayEventEnvelope) => Promise<void>;

  constructor(options: GatewayProcessSessionOptions) {
    this.module = options.module;
    this.onInbound = options.onInbound;
    this.onEvent = options.onEvent;
  }

  get isRunning(): boolean {
    return this.child !== null && !this.child.killed;
  }

  async start(): Promise<void> {
    if (this.started && this.child && !this.child.killed) return;

    const processConfig = this.module.manifest.process;
    const args = processConfig.args ?? [];
    const cwd = processConfig.cwd ?? this.module.moduleDir;

    const child = spawn(processConfig.command, args, {
      cwd,
      env: {
        ...process.env,
        ...(processConfig.env ?? {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child = child;
    this.started = true;

    const stdoutReader = createInterface({ input: child.stdout });
    stdoutReader.on('line', (line: string) => {
      this.handleStdoutLine(line).catch((error) => {
        console.error(`[Gateway:${this.module.manifest.id}] handle stdout line failed: ${String(error)}`);
      });
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      if (text.trim().length > 0) {
        console.warn(`[Gateway:${this.module.manifest.id}] stderr: ${text.trim()}`);
      }
    });

    child.on('error', (error: Error) => {
      this.rejectAllPending(error);
    });

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      const reason = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`;
      this.rejectAllPending(new Error(`gateway process exited with ${reason}`));
      this.child = null;
      this.started = false;
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;

    child.kill('SIGTERM');
    this.child = null;
    this.started = false;
    this.rejectAllPending(new Error('gateway session stopped'));
  }

  async request(deliveryMode: GatewayDeliveryMode, message: unknown): Promise<unknown> {
    await this.start();
    if (!this.child) {
      throw new Error(`gateway session ${this.module.manifest.id} is not running`);
    }

    const requestId = this.nextRequestId();
    const envelope: GatewayRequestEnvelope = {
      type: 'request',
      requestId,
      deliveryMode,
      message,
    };

    if (deliveryMode === 'async') {
      const ackPromise = this.waitForAck(requestId);
      this.writeEnvelope(envelope);
      const ack = await ackPromise;
      return {
        accepted: ack.accepted,
        requestId,
        gatewayId: this.module.manifest.id,
      };
    }

    const resultPromise = this.waitForResult(requestId);
    this.writeEnvelope(envelope);
    const result = await resultPromise;
    if (!result.success) {
      throw new Error(result.error || `gateway ${this.module.manifest.id} returned failure`);
    }
    return result.output;
  }

  private async handleStdoutLine(line: string): Promise<void> {
    const text = line.trim();
    if (text.length === 0) return;
    const envelope = parseOutboundEnvelope(text);
    if (!envelope) return;

    switch (envelope.type) {
      case 'ack': {
        const pending = this.pendingAck.get(envelope.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingAck.delete(envelope.requestId);
        pending.resolve(envelope);
        return;
      }
      case 'result': {
        const pending = this.pendingResult.get(envelope.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingResult.delete(envelope.requestId);
        pending.resolve(envelope);
        return;
      }
      case 'input': {
        if (!this.onInbound) return;
        await this.onInbound(envelope);
        return;
      }
      case 'event': {
        if (!this.onEvent) return;
        await this.onEvent(envelope);
        return;
      }
      default:
        return;
    }
  }

  private writeEnvelope(envelope: GatewayRequestEnvelope): void {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error(`gateway ${this.module.manifest.id} stdin is not writable`);
    }
    this.child.stdin.write(`${JSON.stringify(envelope)}\n`);
  }

  private waitForAck(requestId: string): Promise<GatewayAckEnvelope> {
    const timeoutMs = this.module.manifest.process.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    return new Promise<GatewayAckEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAck.delete(requestId);
        reject(new Error(`gateway ${this.module.manifest.id} ack timeout`));
      }, timeoutMs);

      this.pendingAck.set(requestId, { resolve, reject, timer });
    });
  }

  private waitForResult(requestId: string): Promise<GatewayResultEnvelope> {
    const timeoutMs = this.module.manifest.process.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<GatewayResultEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResult.delete(requestId);
        reject(new Error(`gateway ${this.module.manifest.id} result timeout`));
      }, timeoutMs);

      this.pendingResult.set(requestId, { resolve, reject, timer });
    });
  }

  private rejectAllPending(error: Error): void {
    for (const [requestId, pending] of this.pendingAck) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`[${requestId}] ${error.message}`));
    }
    this.pendingAck.clear();

    for (const [requestId, pending] of this.pendingResult) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`[${requestId}] ${error.message}`));
    }
    this.pendingResult.clear();
  }

  private nextRequestId(): string {
    const id = `${this.module.manifest.id}-${Date.now()}-${this.requestSeq}`;
    this.requestSeq += 1;
    return id;
  }
}

function parseOutboundEnvelope(raw: string): GatewayOutboundEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    return null;
  }
  switch (parsed.type) {
    case 'ack':
      if (typeof parsed.requestId !== 'string' || typeof parsed.accepted !== 'boolean') return null;
      return {
        type: 'ack',
        requestId: parsed.requestId,
        accepted: parsed.accepted,
        message: typeof parsed.message === 'string' ? parsed.message : undefined,
      };
    case 'result':
      if (typeof parsed.requestId !== 'string' || typeof parsed.success !== 'boolean') return null;
      return {
        type: 'result',
        requestId: parsed.requestId,
        success: parsed.success,
        output: parsed.output,
        error: typeof parsed.error === 'string' ? parsed.error : undefined,
      };
    case 'input':
      if (parsed.message === undefined) return null;
      return {
        type: 'input',
        target: typeof parsed.target === 'string' ? parsed.target : undefined,
        sender: typeof parsed.sender === 'string' ? parsed.sender : undefined,
        blocking: typeof parsed.blocking === 'boolean' ? parsed.blocking : undefined,
        message: parsed.message,
      };
    case 'event':
      if (typeof parsed.name !== 'string') return null;
      return {
        type: 'event',
        name: parsed.name,
        payload: parsed.payload,
      };
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
