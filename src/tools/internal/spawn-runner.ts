import { spawn } from 'child_process';

export interface SpawnRunnerInput {
  commandArray: string[];
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

export interface SpawnRunnerOutput {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export async function runSpawnCommand(input: SpawnRunnerInput): Promise<SpawnRunnerOutput> {
  const [program, ...args] = input.commandArray;
  const startAt = Date.now();

  return new Promise<SpawnRunnerOutput>((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...(input.env ?? {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, input.timeoutMs);

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.from(chunk));
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.from(chunk));
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code === null ? -1 : code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        timedOut,
        durationMs: Date.now() - startAt,
      });
    });
  });
}
