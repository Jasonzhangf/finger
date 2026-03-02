import { execSync } from 'child_process';
import { createServer } from 'net';

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
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  } catch {
    // noop
  }
}

export async function ensureSingleInstance(port: number): Promise<void> {
  if (await isPortInUse(port)) {
    console.log(`[Server] Port ${port} is in use, killing existing process...`);
    killProcessOnPort(port);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
