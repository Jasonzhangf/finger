/**
 * Dual Daemon Supervisor - 双守护进程架构
 * 
 * 设计：
 * - 两个 daemon 进程互相监控
 * - 一个挂掉另一个立即重启
 * - restart 命令同时重启两个
 * - stop 命令同时停止两个
 * - 支持开机自启 (launchd)
 */

import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { FINGER_PATHS } from '../core/finger-paths.js';
import { logger } from '../core/logger.js';

const log = logger.module('DualDaemon');

const DUAL_DAEMON_PID_FILE = join(FINGER_PATHS.runtime.dir, 'dual-daemon.pid');
const DAEMON_1_PID_FILE = join(FINGER_PATHS.runtime.dir, 'daemon-1.pid');
const DAEMON_2_PID_FILE = join(FINGER_PATHS.runtime.dir, 'daemon-2.pid');

interface DaemonInstance {
  id: number;
  pidFile: string;
  pid?: number;
  process?: ReturnType<typeof spawn>;
}

export class DualDaemonSupervisor {
  private daemon1: DaemonInstance = { id: 1, pidFile: DAEMON_1_PID_FILE };
  private daemon2: DaemonInstance = { id: 2, pidFile: DAEMON_2_PID_FILE };
  private running = false;
  private checkTimer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    if (this.running) {
      log.warn('DualDaemon already running');
      return;
    }

    log.info('Starting DualDaemon Supervisor...');

    // 清理旧的 PID 文件
    this.cleanupPidFiles();

    // 启动两个 daemon 实例
    await this.startDaemon(this.daemon1);
    await this.startDaemon(this.daemon2);

    this.running = true;
    writeFileSync(DUAL_DAEMON_PID_FILE, String(process.pid));

    // 启动健康检查
    this.startHealthCheck();

    log.info('DualDaemon Supervisor started', { pid: process.pid });

    // 处理信号
    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());
    process.on('uncaughtException', (err) => {
      log.error('Uncaught exception:', err);
      this.stop();
      process.exit(1);
    });
  }

  async stop(): Promise<void> {
    log.info('Stopping DualDaemon Supervisor...');
    this.running = false;

    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }

    // 停止两个 daemon
    await this.stopDaemon(this.daemon1);
    await this.stopDaemon(this.daemon2);

    // 清理 PID 文件
    this.cleanupPidFiles();

    log.info('DualDaemon Supervisor stopped');
  }

  async restart(): Promise<void> {
    log.info('Restarting DualDaemon...');
    await this.stop();
    await new Promise(resolve => setTimeout(resolve, 1000));
    await this.start();
    log.info('DualDaemon restarted');
  }

  private async startDaemon(daemon: DaemonInstance): Promise<void> {
    const serverScript = join(process.cwd(), 'dist', 'server', 'index.js');
    
    if (!existsSync(serverScript)) {
      log.error(`Server script not found: ${serverScript}`);
      return;
    }

    const port = daemon.id === 1 ? 9999 : 9997;
    const wsPort = daemon.id === 1 ? 9998 : 9996;

    const child = spawn('node', [serverScript], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        FINGER_DAEMON: '1',
        PORT: String(port),
        WS_PORT: String(wsPort),
        HOST: '127.0.0.1',
      },
    });

    daemon.pid = child.pid;
    daemon.process = child;

    writeFileSync(daemon.pidFile, String(child.pid));

    log.info(`Started daemon ${daemon.id}`, { pid: child.pid, port, wsPort });

    child.on('exit', (code) => {
      log.warn(`Daemon ${daemon.id} exited with code ${code}`);
      if (this.running) {
        // 如果是意外退出，立即重启
        setTimeout(() => this.restartDaemon(daemon), 1000);
      }
    });

    child.unref();
  }

  private async stopDaemon(daemon: DaemonInstance): Promise<void> {
    if (daemon.pid) {
      try {
        process.kill(daemon.pid, 'SIGTERM');
        log.info(`Sent SIGTERM to daemon ${daemon.id}`, { pid: daemon.pid });

        // 等待进程退出
        for (let i = 0; i < 10; i++) {
          try {
            process.kill(daemon.pid, 0);
            await new Promise(resolve => setTimeout(resolve, 100));
          } catch {
            // 进程已退出
            break;
          }
        }

        // 如果还在，强制杀死
        try {
          process.kill(daemon.pid, 0);
          process.kill(daemon.pid, 'SIGKILL');
          log.info(`Sent SIGKILL to daemon ${daemon.id}`, { pid: daemon.pid });
        } catch {
          // 已退出
        }
      } catch (err) {
        log.error(`Failed to stop daemon ${daemon.id}:`, err instanceof Error ? err : new Error(String(err)));
      }
    }

    daemon.pid = undefined;
    daemon.process = undefined;
  }

  private async restartDaemon(daemon: DaemonInstance): Promise<void> {
    if (!this.running) return;

    log.info(`Restarting daemon ${daemon.id}...`);
    await this.stopDaemon(daemon);
    await this.startDaemon(daemon);
  }

  private startHealthCheck(): void {
    this.checkTimer = setInterval(() => {
      this.checkHealth();
    }, 5000); // 每 5 秒检查一次
  }

  private checkHealth(): void {
    if (!this.running) return;

    // 检查 daemon 1
    if (!this.isProcessAlive(this.daemon1.pid)) {
      log.warn('Daemon 1 is not responding, restarting...');
      this.restartDaemon(this.daemon1);
    }

    // 检查 daemon 2
    if (!this.isProcessAlive(this.daemon2.pid)) {
      log.warn('Daemon 2 is not responding, restarting...');
      this.restartDaemon(this.daemon2);
    }
  }

  private isProcessAlive(pid?: number): boolean {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private cleanupPidFiles(): void {
    [DUAL_DAEMON_PID_FILE, DAEMON_1_PID_FILE, DAEMON_2_PID_FILE].forEach(file => {
      try {
        if (existsSync(file)) {
          unlinkSync(file);
        }
      } catch {
        // Ignore
      }
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  getStatus() {
    return {
      running: this.running,
      supervisor: process.pid,
      daemon1: { pid: this.daemon1.pid, alive: this.isProcessAlive(this.daemon1.pid) },
      daemon2: { pid: this.daemon2.pid, alive: this.isProcessAlive(this.daemon2.pid) },
    };
  }
}

// 开机自启：创建 launchd plist
export function createLaunchdPlist(): string {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.finger.dual-daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>node</string>
    <string>${join(process.cwd(), 'dist', 'daemon', 'dual-daemon.js')}</string>
    <string>--start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(FINGER_PATHS.logs.dir, 'dual-daemon.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(FINGER_PATHS.logs.dir, 'dual-daemon-error.log')}</string>
</dict>
</plist>`;

  const plistPath = join(FINGER_PATHS.runtime.dir, 'com.finger.dual-daemon.plist');
  writeFileSync(plistPath, plist);
  log.info('Created launchd plist: ' + plistPath);
  return plistPath;
}

export function enableAutoStart(): void {
  const plistPath = createLaunchdPlist();
  try {
    execSync(`launchctl load -w "${plistPath}"`);
    log.info('Enabled auto-start via launchd');
  } catch (err) {
    log.error('Failed to enable auto-start:', err instanceof Error ? err : new Error(String(err)));
  }
}

export function disableAutoStart(): void {
  const plistPath = join(FINGER_PATHS.runtime.dir, 'com.finger.dual-daemon.plist');
  try {
    if (existsSync(plistPath)) {
      execSync(`launchctl unload -w "${plistPath}"`);
      log.info('Disabled auto-start');
    }
  } catch (err) {
    log.error('Failed to disable auto-start:', err instanceof Error ? err : new Error(String(err)));
  }
}
