/**
 * OpenClaw Input - receive calls from OpenClaw Gate plugins
 */
import { BaseInput } from './base.js';
import { createMessage } from '../core/schema.js';
import type { OpenClawConfig } from '../core/schema.js';
import http from 'http';

export class OpenClawInput extends BaseInput {
  id: string;
  private config: OpenClawConfig;
  private server: http.Server | null = null;

  constructor(id: string, config: OpenClawConfig) {
    super();
    this.id = id;
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const url = new URL(this.config.gatewayUrl);
    const port = parseInt(url.port, 10) || 9997;
    const host = url.hostname || '0.0.0.0';

    this.server = http.createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end('Method Not Allowed');
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400).end('Invalid JSON');
        return;
      }

      if (this.emit) {
        const msg = createMessage('openclaw-call', { payload, pluginId: (payload as Record<string, unknown>).pluginId }, this.id);
        await this.emit(msg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      } else {
        res.writeHead(500).end('No emitter');
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => {
        this.running = true;
        resolve();
      }).on('error', reject);
    });
    console.log(`[Input:${this.id}] OpenClaw listening on ${host}:${port}`);
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close(err => err ? reject(err) : resolve());
      });
      this.server = null;
    }
    this.running = false;
  }
}
