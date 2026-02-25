import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import type { OutputModule } from '../../orchestration/module-registry.js';

const DEFAULT_KERNEL_TIMEOUT_MS = 120_000;

export interface ChatCodexModuleConfig {
  id: string;
  name: string;
  version: string;
  timeoutMs: number;
  binaryPath?: string;
}

export interface ChatCodexRunResult {
  reply: string;
  events: KernelEvent[];
  usedBinaryPath: string;
}

export interface ChatCodexRunner {
  runTurn(text: string): Promise<ChatCodexRunResult>;
}

interface KernelEvent {
  id: string;
  msg: {
    type: string;
    last_agent_message?: string;
    message?: string;
  };
}

interface ChatCodexResponse {
  success: boolean;
  response?: string;
  error?: string;
  module: string;
  latencyMs: number;
  metadata?: {
    binaryPath: string;
    eventCount: number;
  };
}

const DEFAULT_CONFIG: ChatCodexModuleConfig = {
  id: 'chat-codex',
  name: 'Chat Codex Bridge',
  version: '0.1.0',
  timeoutMs: DEFAULT_KERNEL_TIMEOUT_MS,
};

export class ProcessChatCodexRunner implements ChatCodexRunner {
  private readonly timeoutMs: number;
  private readonly binaryPath?: string;

  constructor(options: Pick<ChatCodexModuleConfig, 'timeoutMs' | 'binaryPath'>) {
    this.timeoutMs = options.timeoutMs;
    this.binaryPath = options.binaryPath;
  }

  async runTurn(text: string): Promise<ChatCodexRunResult> {
    const resolvedPath = resolveKernelBinaryPath(this.binaryPath);
    if (!existsSync(resolvedPath)) {
      throw new Error(`kernel bridge binary not found: ${resolvedPath}`);
    }

    return new Promise<ChatCodexRunResult>((resolve, reject) => {
      const child = spawn(resolvedPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });

      const events: KernelEvent[] = [];
      let stderrBuffer = '';
      let replyText: string | undefined;
      let settled = false;
      let shutdownSent = false;

      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };

      const sendSubmission = (submission: unknown): void => {
        if (!child.stdin.writable) return;
        child.stdin.write(`${JSON.stringify(submission)}\n`);
      };

      const sendShutdown = (): void => {
        if (shutdownSent) return;
        shutdownSent = true;
        sendSubmission({ id: 'bye', op: { type: 'shutdown' } });
        child.stdin.end();
      };

      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        settle(() => reject(new Error(`chat-codex timed out after ${this.timeoutMs}ms`)));
      }, this.timeoutMs);

      const stdoutLines = createInterface({ input: child.stdout });
      stdoutLines.on('line', (line: string) => {
        const parsed = parseKernelEvent(line);
        if (!parsed) return;

        events.push(parsed);
        const eventType = parsed.msg.type;

        if (parsed.id === 'u1' && eventType === 'error') {
          sendShutdown();
          const errorMessage = parsed.msg.message ?? 'chat-codex kernel error';
          settle(() => reject(new Error(errorMessage)));
          return;
        }

        if (parsed.id === 'u1' && eventType === 'task_complete') {
          if (parsed.msg.last_agent_message && parsed.msg.last_agent_message.trim().length > 0) {
            replyText = parsed.msg.last_agent_message;
          }
          sendShutdown();
          return;
        }

        if (eventType === 'shutdown_complete') {
          const finalReply = replyText;
          if (!finalReply) {
            settle(() => reject(new Error('chat-codex got empty model reply')));
            return;
          }

          settle(() => {
            resolve({
              reply: finalReply,
              events,
              usedBinaryPath: resolvedPath,
            });
          });
        }
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderrBuffer += chunk.toString();
      });

      child.on('error', (error: Error) => {
        settle(() => reject(error));
      });

      child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        const status = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`;
        const stderrMessage = stderrBuffer.trim();
        const detail = stderrMessage.length > 0 ? `; stderr: ${stderrMessage}` : '';
        settle(() => reject(new Error(`chat-codex process exited with ${status}${detail}`)));
      });

      sendSubmission({
        id: 'u1',
        op: {
          type: 'user_turn',
          items: [{ type: 'text', text }],
        },
      });
    });
  }
}

export function createChatCodexModule(
  config: Partial<ChatCodexModuleConfig> = {},
  runner?: ChatCodexRunner,
): OutputModule {
  const mergedConfig: ChatCodexModuleConfig = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  const activeRunner =
    runner ??
    new ProcessChatCodexRunner({
      timeoutMs: mergedConfig.timeoutMs,
      binaryPath: mergedConfig.binaryPath,
    });

  return {
    id: mergedConfig.id,
    type: 'output',
    name: mergedConfig.name,
    version: mergedConfig.version,
    metadata: {
      provider: 'codex',
      bridge: 'rust-kernel',
    },
    handle: async (message: unknown, callback?: (result: unknown) => void): Promise<unknown> => {
      const startedAt = Date.now();
      const text = extractInputText(message);

      if (!text) {
        const invalid: ChatCodexResponse = {
          success: false,
          error: 'No input text provided',
          module: mergedConfig.id,
          latencyMs: Date.now() - startedAt,
        };
        if (callback) callback(invalid);
        return invalid;
      }

      try {
        const runResult = await activeRunner.runTurn(text);
        const response: ChatCodexResponse = {
          success: true,
          response: runResult.reply,
          module: mergedConfig.id,
          latencyMs: Date.now() - startedAt,
          metadata: {
            binaryPath: runResult.usedBinaryPath,
            eventCount: runResult.events.length,
          },
        };
        if (callback) callback(response);
        return response;
      } catch (error) {
        const response: ChatCodexResponse = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          module: mergedConfig.id,
          latencyMs: Date.now() - startedAt,
        };
        if (callback) callback(response);
        return response;
      }
    },
  };
}

function extractInputText(input: unknown): string | null {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (!isRecord(input)) return null;
  const candidateKeys = ['text', 'message', 'prompt', 'content'];

  for (const key of candidateKeys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function parseKernelEvent(line: string): KernelEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  if (typeof parsed.id !== 'string') return null;
  if (!isRecord(parsed.msg)) return null;
  if (typeof parsed.msg.type !== 'string') return null;

  const event: KernelEvent = {
    id: parsed.id,
    msg: {
      type: parsed.msg.type,
    },
  };

  if (typeof parsed.msg.last_agent_message === 'string') {
    event.msg.last_agent_message = parsed.msg.last_agent_message;
  }
  if (typeof parsed.msg.message === 'string') {
    event.msg.message = parsed.msg.message;
  }

  return event;
}

function resolveKernelBinaryPath(configuredPath?: string): string {
  if (configuredPath && configuredPath.length > 0) return configuredPath;
  if (process.env.FINGER_KERNEL_BRIDGE_BIN && process.env.FINGER_KERNEL_BRIDGE_BIN.length > 0) {
    return process.env.FINGER_KERNEL_BRIDGE_BIN;
  }
  return join(process.cwd(), 'rust', 'target', 'debug', 'finger-kernel-bridge-bin');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
