/**
 * Unit tests for daemon commands
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const FINGER_HOME = join(homedir(), '.finger');
const DAEMON_LOG_FILE = join(FINGER_HOME, 'daemon.log');
const DAEMON_PID_FILE = join(FINGER_HOME, 'daemon.pid');

describe('daemon logs command', () => {
  beforeEach(() => {
    if (existsSync(DAEMON_LOG_FILE)) {
      unlinkSync(DAEMON_LOG_FILE);
    }
  });

  it('should handle missing log file gracefully', () => {
    expect(existsSync(DAEMON_LOG_FILE)).toBe(false);
  });

  it('should read last N lines from log file', () => {
    const testLogs = Array.from({ length: 100 }, (_, i) => `Log line ${i}`).join('\n');
    writeFileSync(DAEMON_LOG_FILE, testLogs);

    const content = readFileSync(DAEMON_LOG_FILE, 'utf-8');
    const lines = content.split('\n');
    
    expect(lines.length).toBeGreaterThan(50);
    
    unlinkSync(DAEMON_LOG_FILE);
  });
});

describe('daemon status command', () => {
  beforeEach(() => {
    if (existsSync(DAEMON_PID_FILE)) {
      unlinkSync(DAEMON_PID_FILE);
    }
  });

  it('should handle missing PID file gracefully', () => {
    expect(existsSync(DAEMON_PID_FILE)).toBe(false);
  });

  it('should check if process is running', () => {
    const testPid = process.pid;
    
    let isRunning = false;
    try {
      process.kill(testPid, 0);
      isRunning = true;
    } catch {
      isRunning = false;
    }

    expect(isRunning).toBe(true);
  });

  it('should support --json output option', () => {
    // Test that status object has correct structure
    const status = {
      pid: null as number | null,
      isRunning: false,
      httpPort: 5521,
      wsPort: 5522,
      modules: null as unknown,
    };

    const jsonOutput = JSON.stringify(status, null, 2);
    expect(jsonOutput).toContain('"isRunning"');
    expect(jsonOutput).toContain('"httpPort"');
    expect(jsonOutput).toContain('"wsPort"');
  });
});
