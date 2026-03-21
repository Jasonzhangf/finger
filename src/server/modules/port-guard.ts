import { execSync } from 'child_process';
import { createServer } from 'net';
import { logger } from '../../core/logger.js';

const log = logger.module('port-guard');

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EADDRINUSE'));
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

function killProcessOnPort(port: number): void {
  try {
    const output = execSync(`lsof -ti:${port} 2>/dev/null || true`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = output.split(/\s+/).map((entry) => Number.parseInt(entry, 10)).filter(Number.isFinite);
    if (pids.length === 0) return;
    log.info('Found processes on port', { port, pids: pids.join(', ') });
    for (const pid of pids) {
      try {
        log.info('Killing process on port', { pid, port });
        process.kill(pid, 'SIGKILL');
        log.info('Process killed', { pid });
      } catch (err) {
        log.warn('Failed to kill process', { pid, message: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err) {
    log.warn('Failed to check port', { port, message: err instanceof Error ? err.message : String(err) });
  }
}

export async function ensureSingleInstance(port: number): Promise<void> {
  if (await isPortInUse(port)) {
    log.info('Port in use, killing existing process', { port });
    killProcessOnPort(port);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
