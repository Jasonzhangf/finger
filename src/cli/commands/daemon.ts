/**
 * Daemon commands - logs, status, and management
 */

import { Command } from 'commander';
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { createConsoleLikeLogger } from '../../core/logger/console-like.js';

const clog = createConsoleLikeLogger('Daemon');

const DAEMON_LOG_FILE = FINGER_PATHS.logs.daemonLog;
const DAEMON_PID_FILE = FINGER_PATHS.runtime.daemonPid;
const DAEMON_HTTP_URL = process.env.FINGER_HUB_URL || 'http://localhost:9999';
const DAEMON_HTTP_PORT = 9999;
const DAEMON_WS_PORT = 9998;

export function registerDaemonSubCommands(daemon: Command): void {
  // Logs command
  daemon
    .command('logs')
    .description('View daemon logs (follow mode with -f)')
    .option('-f, --follow', 'Follow log output (tail -f mode)')
    .option('-n, --lines <count>', 'Number of lines to show', '50')
    .action(async (options: { follow?: boolean; lines: string }) => {
      try {
        if (!existsSync(DAEMON_LOG_FILE)) {
          clog.error(`Log file not found: ${DAEMON_LOG_FILE}`);
          process.exit(1);
        }

        if (options.follow) {
          // Tail -f mode
          const tail = spawn('tail', ['-f', DAEMON_LOG_FILE], { stdio: 'inherit' });
          tail.on('error', (err) => {
            clog.error('Failed to tail logs:', err.message);
            process.exit(1);
          });
          process.on('SIGINT', () => {
            tail.kill();
            process.exit(0);
          });
        } else {
          // Show last N lines
          const lines = parseInt(options.lines, 10) || 50;
          const content = readFileSync(DAEMON_LOG_FILE, 'utf-8');
          const allLines = content.split('\n');
          const lastLines = allLines.slice(-lines);
          clog.log(lastLines.join('\n'));
        }
      } catch (error) {
        clog.error('[CLI Error]', error);
        process.exit(1);
      }
    });

  // Enhanced status command
  daemon
    .command('status2')
    .description('Show detailed daemon status with JSON output option')
    .option('-j, --json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        // Check PID file
        let pid: number | null = null;
        if (existsSync(DAEMON_PID_FILE)) {
          const pidContent = readFileSync(DAEMON_PID_FILE, 'utf-8').trim();
          pid = parseInt(pidContent, 10);
        }

        // Check if process is running
        let isRunning = false;
        if (pid) {
          try {
            process.kill(pid, 0); // Check if process exists
            isRunning = true;
          } catch {
            isRunning = false;
          }
        }

        // Try to get module info
        let modules: unknown = null;
        let fetchError: string | null = null;
        if (isRunning) {
          try {
            const res = await fetch(`${DAEMON_HTTP_URL}/api/v1/modules`);
            if (res.ok) {
              modules = await res.json();
            }
          } catch (err) {
            fetchError = err instanceof Error ? err.message : String(err);
          }
        }

        const status = {
          pid,
          isRunning,
          httpPort: DAEMON_HTTP_PORT,
          wsPort: DAEMON_WS_PORT,
          logFile: DAEMON_LOG_FILE,
          error: fetchError,
          modules,
        };

        if (options.json) {
          clog.log(JSON.stringify(status, null, 2));
        } else {
          clog.log(`Daemon Status:`);
          clog.log(`  Running: ${isRunning ? 'Yes' : 'No'}`);
          clog.log(`  PID: ${pid || 'N/A'}`);
          clog.log(`  HTTP Port: ${status.httpPort}`);
          clog.log(`  WebSocket Port: ${status.wsPort}`);
          clog.log(`  Log File: ${status.logFile}`);
          if (fetchError) {
            clog.log(`  Error: ${fetchError}`);
          }
          if (modules) {
            clog.log(`  Modules:`, modules);
          }
        }
      } catch (error) {
        clog.error('[CLI Error]', error);
        process.exit(1);
      }
    });
}
