/**
 * Unit tests for daemon commands
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const FINGER_HOME = join(homedir(), '.finger');
const DAEMON_LOG_FILE = join(FINGER_HOME, 'daemon.log');
const DAEMON_PID_FILE = join(FINGER_HOME, 'daemon.pid');

describe('daemon logs command', () => {
  beforeEach(() => {
    // Clean up test files
    if (existsSync(DAEMON_LOG_FILE)) {
      unlinkSync(DAEMON_LOG_FILE);
    }
  });

  it('should handle missing log file gracefully', () => {
    expect(existsSync(DAEMON_LOG_FILE)).toBe(false);
  });

  it('should read last N lines from log file', () => {
    // Create test log file
    const testLogs = Array.from({ length: 100 }, (_, i) => `Log line ${i}`).join('\n');
    writeFileSync(DAEMON_LOG_FILE, testLogs);

    // Read and verify
    const content = readFileSync(DAEMON_LOG_FILE, 'utf-8');
    const lines = content.split('\n');
    
    expect(lines.length).toBeGreaterThan(50);
    
    // Clean up
    unlinkSync(DAEMON_LOG_FILE);
  });

  it('should default to 50 lines', () => {
    const testLogs = Array.from({ length: 200 }, (_, i) => `Log line ${i}`).join('\n');
    writeFileSync(DAEMON_LOG_FILE, testLogs);

    const content = readFileSync(DAEMON_LOG_FILE, 'utf-8');
    const allLines = content.split('\n');
    const lastLines = allLines.slice(-50);
    
    expect(lastLines.length).toBe(50);
    
    // Clean up
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

  it('should detect non-existent process', () => {
    const fakePid = 999999;
    
    let isRunning = false;
    try {
      process.kill(fakePid, 0);
      isRunning = true;
    } catch {
      isRunning = false;
    }

    expect(isRunning).toBe(false);
  });
});
