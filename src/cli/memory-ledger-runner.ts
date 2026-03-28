#!/usr/bin/env node
import { executeContextLedgerMemory } from '../runtime/context-ledger-memory.js';

const ENV_INPUT_KEY = 'FINGER_CONTEXT_LEDGER_TOOL_INPUT';
const JSON_LINE_PREFIX = '__FINGER_MEMORY_LEDGER_JSON__';

interface CliOptions {
  input?: string;
  fromEnv?: boolean;
  jsonLine?: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  try {
    const rawInput = resolveInputPayload(options);
    const result = await executeContextLedgerMemory(rawInput);
    if (options.jsonLine) {
      await writeStream(process.stdout, `${JSON_LINE_PREFIX}${JSON.stringify(result)}\n`);
    } else {
      await writeStream(process.stdout, `${JSON.stringify(result, null, 2)}\n`);
    }
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.jsonLine) {
      await writeStream(process.stdout, `${JSON_LINE_PREFIX}${JSON.stringify({ ok: false, error: message })}\n`);
    } else {
      await writeStream(process.stderr, `[memory-ledger-runner] failed: ${message}\n`);
    }
    process.exit(1);
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--from-env') {
      options.fromEnv = true;
      continue;
    }
    if (arg === '--json-line') {
      options.jsonLine = true;
      continue;
    }
    if ((arg === '-i' || arg === '--input') && i + 1 < args.length) {
      options.input = args[i + 1];
      i += 1;
      continue;
    }
  }
  return options;
}

function resolveInputPayload(options: CliOptions): unknown {
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

function writeStream(stream: NodeJS.WriteStream, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(content, (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

void main();
