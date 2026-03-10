/**
 * OpenClaw Output - send responses back to OpenClaw Gate plugins
 */
import { BaseOutput } from './base.js';
import type { Message } from '../core/schema.js';
import type { OpenClawConfig } from '../core/schema.js';
import http from 'http';

export class OpenClawOutput extends BaseOutput {
  id: string;
  private config: OpenClawConfig;

  constructor(id: string, config: OpenClawConfig) {
    super();
    this.id = id;
    this.config = config;
  }

  async start(): Promise<void> {
    this.running = true;
    console.log(`[Output:${this.id}] OpenClaw output ready`);
  }

  async handle(message: Message): Promise<unknown> {
    const url = new URL(this.config.gatewayUrl);
    const port = parseInt(url.port, 10) || 9997;
    const host = url.hostname || '127.0.0.1';
    const timeoutMs = this.config.timeoutMs || 30000;

    return new Promise((resolve, reject) => {
      const body = JSON.stringify(message);
      const req = http.request(
        { hostname: host, port, method: 'POST', path: '/callback', timeout: timeoutMs, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ statusCode: res.statusCode, body: data });
            } else {
              reject(new Error(`OpenClaw callback failed: ${res.statusCode}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('OpenClaw callback timeout')); });
      req.write(body);
      req.end();
    });
  }
}
