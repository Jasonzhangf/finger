import type { Command } from 'commander';
import { executeContextLedgerMemory } from '../runtime/context-ledger-memory.js';

const ENV_INPUT_KEY = 'FINGER_CONTEXT_LEDGER_TOOL_INPUT';

interface MemoryLedgerRunOptions {
  input?: string;
  fromEnv?: boolean;
  jsonLine?: boolean;
}

export function registerMemoryLedgerCommand(program: Command): void {
  program
    .command('memory-ledger')
    .description('时间线上下文记忆工具（query/insert）')
    .command('run')
    .description('执行 context ledger memory 操作')
    .option('-i, --input <json>', '输入 JSON')
    .option('--from-env', `从环境变量 ${ENV_INPUT_KEY} 读取 JSON`)
    .option('--json-line', '以单行 JSON 输出')
    .action(async (options: MemoryLedgerRunOptions) => {
      try {
        const rawInput = resolveInputPayload(options);
        const result = await executeContextLedgerMemory(rawInput);
        if (options.jsonLine) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } else {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        }
        process.exit(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (options.jsonLine) {
          process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
        } else {
          process.stderr.write(`[memory-ledger] failed: ${message}\n`);
        }
        process.exit(1);
      }
    });
}

function resolveInputPayload(options: MemoryLedgerRunOptions): unknown {
  if (options.fromEnv) {
    const envPayload = process.env[ENV_INPUT_KEY];
    if (!envPayload || envPayload.trim().length === 0) {
      throw new Error(`${ENV_INPUT_KEY} is empty`);
    }
    return parseJson(envPayload);
  }
  if (options.input && options.input.trim().length > 0) {
    return parseJson(options.input);
  }

  const fallback = process.env[ENV_INPUT_KEY];
  if (fallback && fallback.trim().length > 0) {
    return parseJson(fallback);
  }
  return {};
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON input: ${message}`);
  }
}
