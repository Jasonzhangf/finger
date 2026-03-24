import { createInterface } from 'readline';
import type { Command } from 'commander';
import type { GatewayRequestEnvelope } from '../gateway/types.js';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';

const clog = createConsoleLikeLogger('GatewayWorker');

interface WorkerOptions {
  adapter: 'chat' | 'chat-codex';
  daemonUrl: string;
  target: string;
}

interface MessageApiResponse {
  messageId?: string;
  status?: string;
  result?: unknown;
  error?: string;
}

export function registerGatewayWorkerCommand(program: Command): void {
  program
    .command('gateway-worker')
    .description('Internal gateway worker process (stdin/stdout JSONL protocol)')
    .requiredOption('--adapter <type>', 'chat | chat-codex')
    .option('--daemon-url <url>', 'Daemon URL', process.env.FINGER_HUB_URL || 'http://localhost:9999')
    .option('--target <moduleId>', 'Target module ID')
    .action(async (options: { adapter: string; daemonUrl: string; target?: string }) => {
      const adapter = normalizeAdapter(options.adapter);
      if (!adapter) {
        clog.error('Invalid adapter, expected: chat | chat-codex');
        process.exit(1);
        return;
      }

      const target = options.target || (adapter === 'chat-codex' ? 'finger-project-agent' : 'router-chat-agent');
      await runGatewayWorker({
        adapter,
        daemonUrl: options.daemonUrl,
        target,
      });
      process.exit(0);
    });
}

async function runGatewayWorker(options: WorkerOptions): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const request = parseRequestEnvelope(trimmed);
    if (!request) continue;
    void handleRequest(request, options);
  }
}

async function handleRequest(request: GatewayRequestEnvelope, options: WorkerOptions): Promise<void> {
  writeEnvelope({
    type: 'ack',
    requestId: request.requestId,
    accepted: true,
  });

  try {
    const output = await routeRequestToDaemon(request, options);
    writeEnvelope({
      type: 'result',
      requestId: request.requestId,
      success: true,
      output,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeEnvelope({
      type: 'result',
      requestId: request.requestId,
      success: false,
      error: message,
    });
  }
}

async function routeRequestToDaemon(request: GatewayRequestEnvelope, options: WorkerOptions): Promise<unknown> {
  // 结构化日志：记录即将 POST 的 body 中的 sessionId 信息
  const msg = request.message;
  const msgSessionId = msg && typeof msg === 'object' ? (msg as Record<string, unknown>).sessionId : undefined;
  const meta = msg && typeof msg === 'object' && typeof (msg as Record<string, unknown>).metadata === 'object'
    ? (msg as Record<string, Record<string, unknown>>).metadata : undefined;
  const metaSessionId = meta?.sessionId;
  const metaUnderscoreId = meta?.session_id;
  process.stderr.write(JSON.stringify({
    event: 'gateway-worker.routeRequestToDaemon',
    target: options.target,
    'message.sessionId': msgSessionId,
    'message.metadata.sessionId': metaSessionId,
    'message.metadata.session_id': metaUnderscoreId,
    traceId: request.requestId,
  }) + '\n');

  const response = await fetch(`${options.daemonUrl}/api/v1/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target: options.target,
      message: request.message,
      blocking: true,
    }),
  });

  const payload = (await response.json()) as MessageApiResponse;
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  if (options.adapter === 'chat-codex') {
    return normalizeChatCodexOutput(payload.result);
  }

  return normalizeChatOutput(payload.result);
}

function normalizeChatOutput(result: unknown): unknown {
  return result;
}

function normalizeChatCodexOutput(result: unknown): unknown {
  if (!isRecord(result)) return result;
  const success = typeof result.success === 'boolean' ? result.success : undefined;
  if (success === false) {
    return {
      success: false,
      error: typeof result.error === 'string' ? result.error : 'finger-project-agent request failed',
    };
  }
  return result;
}

function writeEnvelope(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parseRequestEnvelope(raw: string): GatewayRequestEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.type !== 'request') return null;
  if (typeof parsed.requestId !== 'string') return null;
  if (parsed.deliveryMode !== 'sync' && parsed.deliveryMode !== 'async') return null;
  return {
    type: 'request',
    requestId: parsed.requestId,
    deliveryMode: parsed.deliveryMode,
    message: parsed.message,
    metadata: isRecord(parsed.metadata) ? parsed.metadata : undefined,
  };
}

function normalizeAdapter(value: string): WorkerOptions['adapter'] | null {
  if (value === 'chat' || value === 'chat-codex') {
    return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
