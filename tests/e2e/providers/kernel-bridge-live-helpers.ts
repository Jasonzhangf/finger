import { execSync, spawn, type ChildProcess } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

export interface KernelEvent {
  id: string;
  msg: {
    type: string;
    [key: string]: unknown;
  };
}

export interface KernelSubmission {
  id: string;
  op:
    | {
        type: 'user_turn';
        items: Array<{
          type: 'text' | 'image';
          text?: string;
          image_url?: string;
        }>;
        options?: Record<string, unknown>;
      }
    | { type: 'shutdown' };
}

export interface KernelProviderSummary {
  providerId: string | null;
  wireApi: string | null;
  model: string | null;
  baseUrl: string | null;
}

export interface LiveKernelBridge {
  readonly configPath: string;
  readonly provider: KernelProviderSummary;
  readonly events: KernelEvent[];
  readonly stderrLines: string[];
  submit: (submission: KernelSubmission) => void;
  waitForEvent: (
    predicate: (event: KernelEvent) => boolean,
    timeoutMs?: number,
    fromIndex?: number,
  ) => Promise<KernelEvent>;
  shutdown: () => Promise<void>;
}

export const RUN_LIVE_MODEL_ROUND_E2E = process.env.FINGER_RUN_LIVE_MODEL_ROUND_E2E === '1';

const rustDir = resolve(import.meta.dirname, '../../../rust');
const binaryPath = resolve(rustDir, 'target/release/finger-kernel-bridge-bin');

export function buildKernelBridgeBinary(): void {
  execSync('cargo build --release', { cwd: rustDir, stdio: 'inherit' });
}

export function readKernelProviderSummary(configPath: string): KernelProviderSummary {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as {
    kernel?: {
      provider?: string;
      providers?: Record<string, { wire_api?: string; model?: string; base_url?: string }>;
    };
  };

  const providerId = raw.kernel?.provider ?? null;
  const provider = providerId ? raw.kernel?.providers?.[providerId] : undefined;

  return {
    providerId,
    wireApi: provider?.wire_api ?? null,
    model: provider?.model ?? null,
    baseUrl: provider?.base_url ?? null,
  };
}

export async function startLiveKernelBridge(configPath: string): Promise<LiveKernelBridge> {
  const provider = readKernelProviderSummary(configPath);
  const kernelProcess = spawn(binaryPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FINGER_CONFIG_PATH: configPath,
    },
  });

  const events: KernelEvent[] = [];
  const stderrLines: string[] = [];
  let stdoutBuffer = '';

  kernelProcess.stdout?.on('data', (data) => {
    stdoutBuffer += data.toString();
    while (stdoutBuffer.includes('\n')) {
      const newlineIndex = stdoutBuffer.indexOf('\n');
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as KernelEvent);
      } catch {
        // ignore non-json lines
      }
    }
  });

  kernelProcess.stderr?.on('data', (data) => {
    stderrLines.push(...data.toString().split('\n').filter(Boolean));
  });

  const waitForEvent = async (
    predicate: (event: KernelEvent) => boolean,
    timeoutMs: number = 30_000,
    fromIndex: number = 0,
  ): Promise<KernelEvent> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      for (let index = fromIndex; index < events.length; index += 1) {
        const event = events[index];
        if (predicate(event)) {
          return event;
        }
      }
      if (kernelProcess.exitCode !== null) {
        throw new Error(
          `kernel exited early with code=${kernelProcess.exitCode}; stderr=${stderrLines.join('\n')}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out after ${timeoutMs}ms; stderr=${stderrLines.join('\n')}`);
  };

  const submit = (submission: KernelSubmission): void => {
    if (!kernelProcess.stdin || kernelProcess.stdin.destroyed) {
      throw new Error('kernel stdin is not writable');
    }
    kernelProcess.stdin.write(`${JSON.stringify(submission)}\n`);
  };

  const waitForExit = async (processRef: ChildProcess, timeoutMs: number): Promise<void> => {
    if (processRef.exitCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`kernel did not exit within ${timeoutMs}ms`));
      }, timeoutMs);

      const handleExit = () => {
        cleanup();
        resolve();
      };

      const cleanup = () => {
        clearTimeout(timeoutId);
        processRef.off('exit', handleExit);
      };

      processRef.on('exit', handleExit);
    });
  };

  const shutdown = async (): Promise<void> => {
    if (kernelProcess.exitCode !== null) return;
    const fromIndex = events.length;
    submit({ id: `shutdown-${Date.now()}`, op: { type: 'shutdown' } });
    kernelProcess.stdin?.end();
    await waitForEvent((event) => event.msg.type === 'shutdown_complete', 5_000, fromIndex);
    await waitForExit(kernelProcess, 5_000);
  };

  await waitForEvent((event) => event.msg.type === 'session_configured', 5_000);

  return {
    configPath,
    provider,
    events,
    stderrLines,
    submit,
    waitForEvent,
    shutdown,
  };
}
