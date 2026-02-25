import { createInterface } from 'readline';
import type { Command } from 'commander';

interface ChatCodexModuleResult {
  success?: boolean;
  response?: string;
  error?: string;
}

interface MessageApiResponse {
  messageId?: string;
  status?: string;
  result?: unknown;
  error?: string;
}

interface ChatCodexCommandOptions {
  url: string;
  target: string;
  interactive: boolean;
}

export function registerChatCodexCommand(program: Command): void {
  const defaultDaemonUrl = process.env.FINGER_HUB_URL || 'http://localhost:9999';

  program
    .command('chat-codex')
    .description('通过 daemon gateway 调用 chat-codex 模块')
    .argument('[input]', '单轮输入文本')
    .option('-u, --url <url>', 'Daemon URL', defaultDaemonUrl)
    .option('-t, --target <id>', 'Target module ID', 'chat-codex-gateway')
    .option('-i, --interactive', '交互模式')
    .action(async (input: string | undefined, options: ChatCodexCommandOptions) => {
      if (options.interactive || !input) {
        await runInteractiveChat(options.url, options.target);
        process.exit(0);
        return;
      }

      try {
        const reply = await sendChatCodexTurn(options.url, options.target, input);
        console.log(reply);
        process.exit(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[chat-codex] ${message}`);
        process.exit(1);
      }
    });
}

export async function sendChatCodexTurn(daemonUrl: string, target: string, input: string): Promise<string> {
  const endpoint = `${daemonUrl}/api/v1/message`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target,
        message: { text: input },
        blocking: true,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`无法连接 daemon: ${endpoint} (${message})`);
  }

  const raw = await response.text();
  let payload: MessageApiResponse = {};
  if (raw.trim().length > 0) {
    try {
      payload = JSON.parse(raw) as MessageApiResponse;
    } catch {
      throw new Error(`Invalid JSON response from daemon (${response.status})`);
    }
  }

  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  const moduleResult = asModuleResult(payload.result);
  if (!moduleResult) {
    throw new Error('Unexpected response format from daemon');
  }

  if (!moduleResult.success) {
    throw new Error(moduleResult.error || 'chat-codex request failed');
  }

  if (!moduleResult.response) {
    throw new Error('chat-codex returned empty response');
  }

  return moduleResult.response;
}

async function runInteractiveChat(daemonUrl: string, target: string): Promise<void> {
  console.log('\n🤖 chat-codex interactive mode');
  console.log('Type /exit to quit\n');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You: ',
  });

  safePrompt(rl);

  for await (const line of rl) {
    const input = line.trim();

    if (!input) {
      safePrompt(rl);
      continue;
    }

    if (input === '/exit' || input === '/quit') {
      break;
    }

    try {
      const reply = await sendChatCodexTurn(daemonUrl, target, input);
      console.log(`Codex: ${reply}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}\n`);
    }

    safePrompt(rl);
  }

  const status = rl as unknown as { closed?: boolean };
  if (!status.closed) {
    rl.close();
  }
  process.stdin.pause();
}

function asModuleResult(value: unknown): ChatCodexModuleResult | null {
  if (!isRecord(value)) return null;

  if (isRecord(value.output)) {
    return {
      success: typeof value.output.success === 'boolean' ? value.output.success : undefined,
      response: typeof value.output.response === 'string' ? value.output.response : undefined,
      error: typeof value.output.error === 'string' ? value.output.error : undefined,
    };
  }

  return {
    success: typeof value.success === 'boolean' ? value.success : undefined,
    response: typeof value.response === 'string' ? value.response : undefined,
    error: typeof value.error === 'string' ? value.error : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function safePrompt(rl: ReturnType<typeof createInterface>): void {
  const status = rl as unknown as { closed?: boolean };
  if (status.closed) return;

  try {
    rl.prompt();
  } catch (error) {
    const err = error as { code?: string };
    if (err.code !== 'ERR_USE_AFTER_CLOSE') {
      throw error;
    }
  }
}
