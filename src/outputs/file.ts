/**
 * File Output - append to file
 */
import { BaseOutput } from './base.js';
import type { Message } from '../core/schema.js';
import fs from 'fs';
import path from 'path';

export interface FileConfig {
  path: string;
  format?: "jsonl" | "text";
}

export class FileOutput extends BaseOutput {
  id: string;
  private config: FileConfig;

  constructor(id: string, config: FileConfig) {
    super();
    this.id = id;
    this.config = config;
  }

  async start(): Promise<void> {
    const dir = path.dirname(this.config.path);
    fs.mkdirSync(dir, { recursive: true });
    this.running = true;
    console.log(`[Output:${this.id}] File ready: ${this.config.path}`);
  }

  async handle(message: Message): Promise<unknown> {
    const line = this.config.format === "text" 
      ? `[${new Date().toISOString()}] ${message.type}: ${JSON.stringify(message.payload)}\n`
      : JSON.stringify(message) + "\n";
    
    fs.appendFileSync(this.config.path, line);
    return { written: true };
  }
}
