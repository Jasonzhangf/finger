/**
 * Dual Daemon Supervisor - 双守护进程架构
 * 
 * 设计：
 * - 两个 daemon 进程互相监控
 * - 一个挂掉另一个立即重启
 * - restart 命令同时重启两个
 * - stop 命令同时停止两个
 * - 支持开机自启 (launchd)
 * 
 * 安全机制：
 * - 最大重启次数限制 (MAX_RESTART_ATTEMPTS)
 * - 启动冷却期 (START_COOLDOWN_MS)
 * - 指数退避重启延迟
 */

import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { FINGER_PATHS } from '../core/finger-paths.js';
import { logger } from '../core/logger.js';
import dgram from 'dgram';

const log = logger.module('DualDaemon');

interface DaemonHeartbeat {
  type: 'daemon_heartbeat';
  daemonId: 1 | 2;
  pid: number;
  sequence: number;
  timestamp: number;
  status: {
    httpPort: number;
    wsPort: number;
    uptime: number;
  };
}

const DUAL_DAEMON_PID_FILE = join(FINGER_PATHS.runtime.dir, 'dual-daemon.pid');
const DAEMON_1_PID_FILE = join(FINGER_PATHS.runtime.dir, 'daemon-1.pid');
const DAEMON_2_PID_FILE = join(FINGER_PATHS.runtime.dir, 'daemon-2.pid');

const MAX_RESTART_ATTEMPTS = 3;
const START_COOLDOWN_MS = 5000;

// DualDaemon mutual heartbeat ports
const DAEMON_1_UDP_PORT = 10001;
const DAEMON_2_UDP_PORT = 10002;
const HEARTBEAT_INTERVAL_MS = 5000;  // 5 seconds
const MISSED_HEARTBEAT_THRESHOLD = 3;  // 3 missed = 15 seconds

interface DaemonInstance {
  id: number;
  pidFile: string;
  pid?: number;
  process?: ReturnType<typeof spawn>;
  restartCount: number;
  lastStart?: number;
  lastExit?: number;
  heartbeatSocket?: dgram.Socket;
  lastHeartbeatSequence?: number;
  heartbeatMissedCount?: number;
  uptimeStart?: number;
}

export class DualDaemonSupervisor {
  private daemon1: DaemonInstance = { id: 1, pidFile: DAEMON_1_PID_FILE, restartCount: 0 };
  private daemon2: DaemonInstance = { id: 2, pidFile: DAEMON_2_PID_FILE, restartCount: 0 };
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

    // 关闭心跳 sockets
    if (this.daemon1.heartbeatSocket) {
      this.daemon1.heartbeatSocket.close();
      this.daemon1.heartbeatSocket = undefined;
    }
    if (this.daemon2.heartbeatSocket) {
      this.daemon2.heartbeatSocket.close();
      this.daemon2.heartbeatSocket = undefined;
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

    // 检查是否在冷却期内
    const now = Date.now();
    if (daemon.lastStart && now - daemon.lastStart < START_COOLDOWN_MS) {
      log.warn(`Daemon ${daemon.id} start cooldown, waiting...`);
      return;
    }

    // 检查重启次数
    if (daemon.restartCount >= MAX_RESTART_ATTEMPTS) {
      log.error(`Daemon ${daemon.id} exceeded max restart attempts (${MAX_RESTART_ATTEMPTS})`);
      return;
    }

    const child = spawn('node', [serverScript], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
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
    daemon.lastStart = Date.now();
    daemon.uptimeStart = Date.now();

    writeFileSync(daemon.pidFile, String(child.pid));

    log.info(`Started daemon ${daemon.id}`, { pid: child.pid, port, wsPort });

    child.on('exit', (code) => {
      log.warn(`Daemon ${daemon.id} exited with code ${code}`);
      if (this.running) {
        daemon.lastExit = Date.now();

        // 检查是否是启动后立即退出（< 5秒）
        const uptime = daemon.lastExit - (daemon.lastStart || 0);
        if (uptime < 5000) {
          daemon.restartCount++;
          log.warn(`Daemon ${daemon.id} exited quickly (${uptime}ms), restart count: ${daemon.restartCount}/${MAX_RESTART_ATTEMPTS}`);
        } else {
          // 正常运行后退出，重置重启计数
          daemon.restartCount = 0;
        }

        // 如果是意外退出，延迟重启（指数退避）
        const delay = Math.min(1000 * Math.pow(2, daemon.restartCount), 30000);
        log.info(`Daemon ${daemon.id} will restart in ${delay}ms`);
        setTimeout(() => this.restartDaemon(daemon), delay);
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
    if (daemon.restartCount >= MAX_RESTART_ATTEMPTS) {
      log.error(`Daemon ${daemon.id} not restarting: exceeded max attempts`);
      return;
    }

    log.info(`Restarting daemon ${daemon.id}...`);
    await this.stopDaemon(daemon);
    await this.startDaemon(daemon);
  }

  private startHealthCheck(): void {
    // 启动 UDP 心跳监听
    this.startHeartbeatListener(this.daemon1, DAEMON_1_UDP_PORT);
    this.startHeartbeatListener(this.daemon2, DAEMON_2_UDP_PORT);

    // 启动心跳广播
    this.startHeartbeatBroadcaster(this.daemon1, DAEMON_2_UDP_PORT);
    this.startHeartbeatBroadcaster(this.daemon2, DAEMON_1_UDP_PORT);

    // 启动心跳检测循环
    this.checkTimer = setInterval(() => {
      this.checkHeartbeats();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private startHeartbeatListener(daemon: DaemonInstance, port: number): void {
    const socket = dgram.createSocket('udp4');
    
    socket.on('message', (msg) => {
      try {
        const heartbeat: DaemonHeartbeat = JSON.parse(msg.toString());
        if (heartbeat.type === 'daemon_heartbeat' && heartbeat.daemonId !== daemon.id) {
          // 收到对方的心跳，重置计数
          daemon.lastHeartbeatSequence = heartbeat.sequence;
          daemon.heartbeatMissedCount = 0;
          log.debug(`Daemon ${daemon.id} received heartbeat from Daemon ${heartbeat.daemonId}`, {
            sequence: heartbeat.sequence,
            pid: heartbeat.pid
          });
        }
      } catch (err) {
        // Ignore parse errors
      }
    });

    socket.bind(port, () => {
      log.info(`Daemon ${daemon.id} heartbeat listener bound to UDP ${port}`);
    });

    daemon.heartbeatSocket = socket;
  }

  private startHeartbeatBroadcaster(daemon: DaemonInstance, targetPort: number): void {
    const socket = dgram.createSocket('udp4');
    let sequence = 0;

    const broadcast = () => {
      if (!this.running || !daemon.pid) return;

      const heartbeat: DaemonHeartbeat = {
        type: 'daemon_heartbeat',
        daemonId: daemon.id as 1 | 2,
        pid: daemon.pid,
        sequence: ++sequence,
        timestamp: Date.now(),
        status: {
          httpPort: daemon.id === 1 ? 9999 : 9997,
          wsPort: daemon.id === 1 ? 9998 : 9996,
          uptime: daemon.uptimeStart ? Date.now() - daemon.uptimeStart : 0,
        }
      };

      const message = Buffer.from(JSON.stringify(heartbeat));
      socket.send(message, 0, message.length, targetPort, '127.0.0.1', (err) => {
        if (err) {
          log.error(`Daemon ${daemon.id} failed to send heartbeat:`, err);
        }
      });
    };

    // 立即发送一次，然后定时发送
    broadcast();
    setInterval(broadcast, HEARTBEAT_INTERVAL_MS);
  }

  private checkHeartbeats(): void {
    if (!this.running) return;

    // 检查 Daemon 1
    this.checkDaemonHeartbeat(this.daemon1);

    // 检查 Daemon 2  
    this.checkDaemonHeartbeat(this.daemon2);
  }

  private checkDaemonHeartbeat(daemon: DaemonInstance): void {
    // 初始化计数
    if (daemon.heartbeatMissedCount === undefined) {
      daemon.heartbeatMissedCount = 0;
    }

    // 增加丢失计数
    daemon.heartbeatMissedCount++;

    if (daemon.heartbeatMissedCount >= MISSED_HEARTBEAT_THRESHOLD) {
      log.warn(`Daemon ${daemon.id} missed ${daemon.heartbeatMissedCount} heartbeats, restarting peer...`);
      // 重启对方 daemon
      const peer = daemon.id === 1 ? this.daemon2 : this.daemon1;
      if (!this.isProcessAlive(peer.pid)) {
        this.restartDaemon(peer);
      }
      // 重置计数
      daemon.heartbeatMissedCount = 0;
    }
  }

  private checkHealth(): void {
    // 保留原有的进程检查作为备份
    if (!this.running) return;

    if (!this.isProcessAlive(this.daemon1.pid)) {
      log.warn('Daemon 1 process not alive, restarting...');
      this.restartDaemon(this.daemon1);
    }

    if (!this.isProcessAlive(this.daemon2.pid)) {
      log.warn('Daemon 2 process not alive, restarting...');
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
      daemon1: {
        pid: this.daemon1.pid,
        alive: this.isProcessAlive(this.daemon1.pid),
        heartbeatSequence: this.daemon1.lastHeartbeatSequence,
        missedHeartbeats: this.daemon1.heartbeatMissedCount ?? 0,
        uptime: this.daemon1.uptimeStart ? Date.now() - this.daemon1.uptimeStart : 0,
      },
      daemon2: {
        pid: this.daemon2.pid,
        alive: this.isProcessAlive(this.daemon2.pid),
        heartbeatSequence: this.daemon2.lastHeartbeatSequence,
        missedHeartbeats: this.daemon2.heartbeatMissedCount ?? 0,
        uptime: this.daemon2.uptimeStart ? Date.now() - this.daemon2.uptimeStart : 0,
      },
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
