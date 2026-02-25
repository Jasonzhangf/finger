/**
 * Finger Daemon Manager
 * 
 * 特性：
 * - 唯一实例管理：新启动自动停止旧 daemon
 * - 默认端口：HTTP 9999 / WebSocket 9998
 * - 孤儿进程清理
 * - 自动加载 autostart 目录模块
 */

import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../core/logger.js';
import { loadModuleManifest } from './module-manifest.js';

export interface DaemonConfig {
  port: number;
  wsPort: number;
  host: string;
  pidFile: string;
  logFile: string;
  serverScript: string;
  autostartDir: string;
}

const DEFAULT_CONFIG: DaemonConfig = {
  port: 9999,
  wsPort: 9998,
  host: '127.0.0.1',
  pidFile: join(homedir(), '.finger', 'daemon.pid'),
  logFile: join(homedir(), '.finger', 'daemon.log'),
  serverScript: join(process.cwd(), 'dist', 'server', 'index.js'),
  autostartDir: join(homedir(), '.finger', 'autostart'),
};

const log = logger.module('Daemon');

export class OrchestrationDaemon {
  private config: DaemonConfig;
  private running = false;

  constructor(config: Partial<DaemonConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureDirs();
  }

  private ensureDirs(): void {
    const fingerDir = join(homedir(), '.finger');
    if (!existsSync(fingerDir)) {
      mkdirSync(fingerDir, { recursive: true });
    }
    if (!existsSync(this.config.autostartDir)) {
      mkdirSync(this.config.autostartDir, { recursive: true });
    }
  }

  private isPortInUse(port: number): boolean {
    try {
      execSync(`lsof -ti :${port}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  private getPidOnPort(port: number): number | null {
    try {
      const output = execSync(`lsof -ti :${port}`, { encoding: 'utf-8' });
      const pid = parseInt(output.trim(), 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  private killProcessOnPort(port: number): void {
    const pid = this.getPidOnPort(port);
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
        let attempts = 0;
        while (this.isPortInUse(port) && attempts < 10) {
          execSync('sleep 0.1');
          attempts++;
        }
        if (this.isPortInUse(port)) {
          process.kill(pid, 'SIGKILL');
        }
        log.info(`Killed old process on port ${port}`, { pid });
      } catch {
        // Ignore
      }
    }
  }

  private cleanupOrphans(): void {
    this.killProcessOnPort(this.config.port);
    this.killProcessOnPort(this.config.wsPort);
    
    if (existsSync(this.config.pidFile)) {
      try {
        const pid = parseInt(readFileSync(this.config.pidFile, 'utf-8'), 10);
        if (pid) {
          try {
            process.kill(pid, 0);
            process.kill(pid, 'SIGTERM');
            log.info('Killed old daemon', { pid });
          } catch {
            // Already dead
          }
        }
        unlinkSync(this.config.pidFile);
      } catch {
        // Ignore
      }
    }
  }

  /**
   * 自动加载 autostart 目录中的所有模块
   */
  private async loadAutostartModules(): Promise<void> {
    if (!existsSync(this.config.autostartDir)) {
      log.info('Autostart directory not found, skipping');
      return;
    }

    const files = readdirSync(this.config.autostartDir).filter(
      (f) => f.endsWith('.js') || f.endsWith('.module.json'),
    );
    
    if (files.length === 0) {
      log.info('No modules in autostart directory');
      return;
    }

    log.info('Loading autostart modules', { count: files.length });

    for (const file of files) {
      const discoveredPath = join(this.config.autostartDir, file);
      let filePath = discoveredPath;

      if (file.endsWith('.module.json')) {
        try {
          const resolved = loadModuleManifest(discoveredPath);
          if (resolved.manifest.type === 'cli-plugin') {
            log.info('Skipping cli-plugin manifest in daemon autostart', { file });
            continue;
          }
          if (resolved.manifest.enabled === false) {
            log.info('Skipping disabled module manifest', { file, id: resolved.manifest.id });
            continue;
          }
          filePath = resolved.entryPath;
        } catch (err) {
          log.error('Invalid module manifest: ' + file + ' - ' + (err instanceof Error ? err.message : String(err)));
          continue;
        }
      }

      try {
        const res = await fetch(`http://localhost:${this.config.port}/api/v1/module/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath })
        });

        const data = await res.json() as { success?: boolean; error?: string };
        
        if (data.success) {
          log.info('Auto-registered module', { file });
        } else {
          log.error('Failed to register module: ' + file + ' - ' + (data.error || 'unknown'));
        }
      } catch (err) {
        log.error('Failed to register module: ' + file + ' - ' + (err instanceof Error ? err.message : String(err)));
      }
    }

    log.info('Autostart loading complete', { total: files.length });
  }

  async start(): Promise<void> {
    if (this.running) {
      log.warn('Daemon already running');
      console.log('Daemon already running');
      return;
    }

    this.cleanupOrphans();

    if (!existsSync(this.config.serverScript)) {
      const msg = `Server script not found: ${this.config.serverScript}. Run 'npm run build' first.`;
      log.error(msg);
      console.error(msg);
      return;
    }

    const logFd = openSync(this.config.logFile, 'a');

    const child = spawn('node', [this.config.serverScript], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        FINGER_DAEMON: '1',
        PORT: this.config.port.toString(),
        WS_PORT: this.config.wsPort.toString(),
        HOST: this.config.host,
      },
    });

    writeFileSync(this.config.pidFile, child.pid?.toString() || '');
    child.unref();
    this.running = true;

    log.info('Daemon started', { pid: child.pid, port: this.config.port, wsPort: this.config.wsPort });
    console.log(`[Daemon] Started with PID ${child.pid} on port ${this.config.port}`);
    console.log(`[Daemon] WebSocket on port ${this.config.wsPort}`);
    console.log(`[Daemon] Logs: ${this.config.logFile}`);

    // 延迟加载 autostart 模块（等待 server 完全启动）
    setTimeout(() => {
      this.loadAutostartModules().catch(err => {
        log.error('Failed to load autostart modules', err);
      });
    }, 2000);
  }

  async stop(): Promise<void> {
    this.cleanupOrphans();
    this.running = false;
    log.info('Daemon stopped');
    console.log('[Daemon] Stopped');
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  isRunning(): boolean {
    if (existsSync(this.config.pidFile)) {
      try {
        const pid = parseInt(readFileSync(this.config.pidFile, 'utf-8'), 10);
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  getConfig(): DaemonConfig {
    return { ...this.config };
  }
}
