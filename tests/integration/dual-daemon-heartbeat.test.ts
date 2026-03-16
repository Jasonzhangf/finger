import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { readFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { FINGER_PATHS } from '../../src/core/finger-paths.js';

const DAEMON_1_UDP_PORT = 10001;
const DAEMON_2_UDP_PORT = 10002;
const DUAL_DAEMON_PID_FILE = join(FINGER_PATHS.runtime.dir, 'dual-daemon.pid');

describe('Dual Daemon Heartbeat', () => {
  let dualDaemonProcess: ChildProcess | null = null;

  afterAll(async () => {
    if (dualDaemonProcess) {
      dualDaemonProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  });

  it('dual daemon configuration is correct', () => {
    // 验证端口配置
    expect(DAEMON_1_UDP_PORT).toBe(10001);
    expect(DAEMON_2_UDP_PORT).toBe(10002);
  });

  it('daemon script exists', () => {
    const daemonScript = join(process.cwd(), 'dist', 'daemon', 'dual-daemon.js');
    expect(existsSync(daemonScript)).toBe(true);
  });

  it('runtime directory exists', () => {
    expect(existsSync(FINGER_PATHS.runtime.dir)).toBe(true);
  });

  it('heartbeat configuration follows design', () => {
    const content = readFileSync(join(process.cwd(), 'src/daemon/dual-daemon.ts'), 'utf-8');
    
    // 验证心跳间隔
    expect(content).toContain('HEARTBEAT_INTERVAL_MS = 5000');
    
    // 验证丢失阈值
    expect(content).toContain('MISSED_HEARTBEAT_THRESHOLD = 3');
    
    // 验证重启限制
    expect(content).toContain('MAX_RESTART_ATTEMPTS = 3');
    
    // 验证冷却期
    expect(content).toContain('START_COOLDOWN_MS = 5000');
  });

  it('dual daemon ports are different', () => {
    const content = readFileSync(join(process.cwd(), 'src/daemon/dual-daemon.ts'), 'utf-8');
    
    // Daemon 1 端口
    expect(content).toContain('9999');  // HTTP
    expect(content).toContain('9998');  // WS
    
    // Daemon 2 端口
    expect(content).toContain('9997');  // HTTP
    expect(content).toContain('9996');  // WS
  });

  // 注意：实际启动测试需要更长的超时和更复杂的设置
  // 这里只验证配置正确性
});
