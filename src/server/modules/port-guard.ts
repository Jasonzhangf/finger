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
    
    if (pids.length === 0) {
      return;
    }
    
    console.log(`[PortGuard] Found ${pids.length} process(es) on port ${port}: ${pids.join(', ')}`);
    
    for (const pid of pids) {
      try {
        console.log(`[PortGuard] Killing process ${pid} on port ${port}...`);
        process.kill(pid, 'SIGKILL');
        console.log(`[PortGuard] Process ${pid} killed`);
      } catch (err) {
        // Process may have already exited
        console.log(`[PortGuard] Failed to kill process ${pid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    // lsof command may have failed
    console.log(`[PortGuard] Failed to check port ${port}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function ensureSingleInstance(port: number): Promise<void> {
  if (await isPortInUse(port)) {
    console.log(`[PortGuard] Port ${port} is in use, killing existing process...`);
    killProcessOnPort(port);
    // Wait for port to be released
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
