/**
 * Exec Output - fork external process
 */
import { BaseOutput } from './base.js';
import type { Message } from '../core/schema.js';
import { spawn, ChildProcess } from 'child_process';

export interface ExecConfig {
  command: string;
  args?: string[];
  cwd?: string;
  restart?: "always" | "never";
}

export class ExecOutput extends BaseOutput {
  id: string;
  private config: ExecConfig;
  private process: ChildProcess | null = null;

  constructor(id: string, config: ExecConfig) {
    super();
    this.id = id;
    this.config = config;
  }

  async start(): Promise<void> {
    this.running = true;
    console.log(`[Output:${this.id}] Exec ready: ${this.config.command}`);
  }

  async handle(message: Message): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const args = this.config.args || [];
      const proc = spawn(this.config.command, [...args], {
        cwd: this.config.cwd || process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => { stdout += data; });
      proc.stderr.on("data", (data) => { stderr += data; });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`Process exited ${code}: ${stderr}`));
        }
      });

      proc.on("error", (err) => reject(err));

      proc.stdin.write(JSON.stringify(message));
      proc.stdin.end();
    });
  }
}

