import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DaemonConfig {
  pidFile: string;
  logFile: string;
  port: number;
  host: string;
  serverScript: string;
}

export class OrchestrationDaemon {
  private process: ChildProcess | null = null;
  private config: DaemonConfig;
  private running = false;

  constructor(config?: Partial<DaemonConfig>) {
    const home = os.homedir();
    const fingerDir = path.join(home, '.finger');
    this.config = {
      pidFile: path.join(fingerDir, 'daemon.pid'),
      logFile: path.join(fingerDir, 'daemon.log'),
      port: 5521,
      host: 'localhost',
      serverScript: path.resolve(__dirname, '../server/index.js'),
      ...config
    };

    if (!fs.existsSync(fingerDir)) {
      fs.mkdirSync(fingerDir, { recursive: true });
    }
  }

  async start(): Promise<void> {
    if (this.running) {
      console.log('Daemon already running (in-process)');
      return;
    }

    if (fs.existsSync(this.config.pidFile)) {
      const pid = parseInt(fs.readFileSync(this.config.pidFile, 'utf-8'), 10);
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, 0);
          console.log(`Daemon already running with PID ${pid}`);
          this.running = true;
          return;
        } catch {
          fs.unlinkSync(this.config.pidFile);
        }
      }
    }

    const serverPath = this.config.serverScript;
    if (!fs.existsSync(serverPath)) {
      console.error(`Server script not found: ${serverPath}. Build first with 'npm run build'.`);
      return;
    }

    const logFd = fs.openSync(this.config.logFile, 'a');
    this.process = spawn('node', [serverPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        FINGER_DAEMON: '1',
        PORT: this.config.port.toString(),
        HOST: this.config.host
      }
    });

    this.process.unref();

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (this.process?.pid) {
          fs.writeFileSync(this.config.pidFile, this.process.pid.toString());
          this.running = true;
          console.log(`Daemon started with PID ${this.process.pid}`);
        }
        resolve();
      }, 500);
    });
  }

  async stop(): Promise<void> {
    if (!fs.existsSync(this.config.pidFile)) {
      console.log('No PID file found, daemon not running');
      return;
    }

    const pid = parseInt(fs.readFileSync(this.config.pidFile, 'utf-8'), 10);
    if (!Number.isFinite(pid)) {
      fs.unlinkSync(this.config.pidFile);
      console.log('Invalid PID file removed');
      return;
    }

    try {
      process.kill(pid, 'SIGTERM');
      fs.unlinkSync(this.config.pidFile);
      this.running = false;
      console.log(`Daemon with PID ${pid} stopped`);
    } catch (err) {
      fs.unlinkSync(this.config.pidFile);
      this.running = false;
      console.error(`Failed to stop daemon process ${pid}, stale PID removed: ${err}`);
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  isRunning(): boolean {
    if (!fs.existsSync(this.config.pidFile)) {
      return false;
    }

    const pid = parseInt(fs.readFileSync(this.config.pidFile, 'utf-8'), 10);
    if (!Number.isFinite(pid)) {
      fs.unlinkSync(this.config.pidFile);
      return false;
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch {
      fs.unlinkSync(this.config.pidFile);
      return false;
    }
  }
}
