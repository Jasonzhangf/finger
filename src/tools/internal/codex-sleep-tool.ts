import { setTimeout as delay } from 'timers/promises';
import type { ProgressDeliveryPolicy } from '../../common/progress-delivery-policy.js';
import {
  readMaskedBoolean,
  readMaskedNumber,
  readMaskedRecord,
  readMaskedString,
} from '../../common/tool-input-mask.js';
import { clockTool } from './codex-clock-tool.js';
import type { InternalTool, ToolExecutionContext } from './types.js';

const MAX_SYNC_SLEEP_MS = 60 * 60 * 1_000;
const MAX_ALLOWED_SLEEP_MS = 7 * 24 * 60 * 60 * 1_000;

interface SleepInjectInput {
  agentId?: string;
  sessionId?: string;
  projectPath?: string;
  channelId?: string;
  prompt?: string;
  progressDelivery?: ProgressDeliveryPolicy;
}

interface SleepParsedInput {
  mode: 'sync' | 'async';
  durationMs: number;
  message: string;
  inject?: SleepInjectInput;
}

interface SleepToolOutput {
  ok: boolean;
  mode: 'sync' | 'async';
  content: string;
  data: Record<string, unknown>;
  timer_id?: string;
}

export const sleepTool: InternalTool<unknown, SleepToolOutput> = {
  name: 'sleep',
  executionModel: 'execution',
  description:
    'Shell-like sleep tool. Supports sync blocking sleep and async scheduled wake-up via clock inject.',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Shell-like syntax, e.g. "sleep 30", "sleep 2m", "sleep 1m 30s".' },
      mode: { type: 'string', enum: ['sync', 'async'], description: 'Sleep mode. Defaults to sync.' },
      duration: { type: 'string', description: 'Duration expression, e.g. "30", "2m", "1h".' },
      seconds: { type: 'number', description: 'Duration in seconds.' },
      inject: {
        type: 'object',
        description: 'For async mode: override callback target and prompt injection metadata.',
        additionalProperties: true,
      },
    },
    additionalProperties: true,
  },
  execute: async (rawInput: unknown, context: ToolExecutionContext): Promise<SleepToolOutput> => {
    const parsed = parseSleepInput(rawInput);

    if (parsed.mode === 'sync') {
      if (parsed.durationMs > MAX_SYNC_SLEEP_MS) {
        throw new Error('sync sleep supports at most 1h; use async mode for longer waits');
      }
      await delay(parsed.durationMs);
      return {
        ok: true,
        mode: 'sync',
        content: `sleep done (${formatDuration(parsed.durationMs)})`,
        data: {
          duration_ms: parsed.durationMs,
          duration: formatDuration(parsed.durationMs),
        },
      };
    }

    const inject = parsed.inject ?? {};
    const agentId = inject.agentId ?? context.agentId;
    const sessionId = inject.sessionId ?? context.sessionId;
    if (!agentId || !sessionId) {
      throw new Error('async sleep requires agentId and sessionId (from caller context or inject override)');
    }

    const wakePrompt = inject.prompt?.trim() || [
      '[SLEEP TIMER WAKE]',
      `duration=${formatDuration(parsed.durationMs)}`,
      `message=${parsed.message}`,
      'Sleep timer completed. Continue from the latest task state.',
    ].join('\n');

    const clockResult = await clockTool.execute(
      {
        action: 'create',
        payload: {
          message: parsed.message,
          schedule_type: 'delay',
          delay_seconds: Math.max(1, Math.ceil(parsed.durationMs / 1000)),
          repeat: false,
          inject: {
            agentId,
            sessionId,
            projectPath: inject.projectPath ?? context.cwd,
            channelId: inject.channelId ?? context.channelId,
            prompt: wakePrompt,
            ...(inject.progressDelivery ? { progressDelivery: inject.progressDelivery } : {}),
          },
        },
      },
      context,
    );

    return {
      ok: true,
      mode: 'async',
      timer_id: clockResult.timer_id,
      content: `sleep scheduled (${formatDuration(parsed.durationMs)})`,
      data: {
        duration_ms: parsed.durationMs,
        duration: formatDuration(parsed.durationMs),
        next_fire_at: clockResult.data?.next_fire_at,
        schedule: clockResult.data?.schedule,
        target_agent_id: agentId,
        target_session_id: sessionId,
      },
    };
  },
};

function parseSleepInput(rawInput: unknown): SleepParsedInput {
  const commandText = extractCommandText(rawInput);
  const commandParsed = parseShellSleepCommand(commandText);

  const modeRaw = readMaskedString(rawInput, ['mode', 'wait_mode', 'sleep_mode'])?.toLowerCase();
  const asyncFlag = readMaskedBoolean(rawInput, ['async', 'non_blocking']);
  const syncFlag = readMaskedBoolean(rawInput, ['sync', 'blocking']);
  const mode: 'sync' | 'async' = modeRaw === 'async' || asyncFlag === true || commandParsed.mode === 'async'
    ? 'async'
    : modeRaw === 'sync' || syncFlag === true || commandParsed.mode === 'sync'
      ? 'sync'
      : 'sync';

  const numericSeconds = readMaskedNumber(rawInput, ['seconds', 'delay_seconds', 'duration_seconds']);
  const explicitDuration = readMaskedString(rawInput, ['duration', 'delay', 'time', 'wait']);

  const durationMs = resolveDurationMs({
    commandText: commandParsed.durationExpression ?? commandText,
    numericSeconds,
    explicitDuration,
  });
  if (durationMs <= 0) throw new Error('sleep duration must be greater than 0');
  if (durationMs > MAX_ALLOWED_SLEEP_MS) throw new Error('sleep duration too large (max 7d)');

  const injectRecord = readMaskedRecord(rawInput, ['inject']);
  const inject = injectRecord ? parseInjectPayload(injectRecord) : undefined;

  const message = readMaskedString(rawInput, ['message'])
    || `sleep ${formatDuration(durationMs)}`;

  return { mode, durationMs, message, ...(inject ? { inject } : {}) };
}

function extractCommandText(rawInput: unknown): string | undefined {
  if (typeof rawInput === 'string' && rawInput.trim().length > 0) return rawInput.trim();
  return readMaskedString(rawInput, ['input', 'cmd', 'command', 'text']);
}

function resolveDurationMs(input: {
  commandText?: string;
  numericSeconds?: number;
  explicitDuration?: string;
}): number {
  if (typeof input.numericSeconds === 'number' && Number.isFinite(input.numericSeconds) && input.numericSeconds > 0) {
    return Math.round(input.numericSeconds * 1000);
  }

  if (input.explicitDuration) {
    return parseDurationExpressionMs(input.explicitDuration);
  }

  if (input.commandText) {
    const trimmed = input.commandText.trim();
    const fromCommand = trimmed.toLowerCase().startsWith('sleep ')
      ? trimmed.slice(6).trim()
      : trimmed;
    return parseDurationExpressionMs(fromCommand);
  }

  throw new Error('sleep requires duration (e.g., "sleep 30", "sleep 2m", or seconds field)');
}

function parseShellSleepCommand(commandText: string | undefined): {
  mode?: 'sync' | 'async';
  durationExpression?: string;
} {
  if (!commandText || commandText.trim().length === 0) return {};
  const trimmed = commandText.trim();
  const raw = trimmed.toLowerCase().startsWith('sleep ')
    ? trimmed.slice(6).trim()
    : trimmed;
  if (!raw) return {};

  const tokens = raw.split(/\s+/).filter((token) => token.length > 0);
  const durationTokens: string[] = [];
  let mode: 'sync' | 'async' | undefined;

  for (const token of tokens) {
    const normalized = token.trim().toLowerCase();
    if (normalized === '--async' || normalized === '-a') {
      mode = 'async';
      continue;
    }
    if (normalized === '--sync' || normalized === '-s') {
      mode = 'sync';
      continue;
    }
    durationTokens.push(token);
  }

  return {
    ...(mode ? { mode } : {}),
    ...(durationTokens.length > 0 ? { durationExpression: durationTokens.join(' ') } : {}),
  };
}

function parseDurationExpressionMs(expression: string): number {
  const trimmed = expression.trim();
  if (!trimmed) throw new Error('sleep duration expression is empty');

  const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
  let totalMs = 0;

  for (const token of tokens) {
    totalMs += parseDurationTokenMs(token);
  }

  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    throw new Error(`invalid sleep duration: ${expression}`);
  }
  return Math.round(totalMs);
}

function parseDurationTokenMs(token: string): number {
  const normalized = token.trim().toLowerCase();
  if (!normalized) return 0;

  const unitRegex = /([0-9]*\.?[0-9]+)(ms|s|m|h|d)?/g;
  let consumed = '';
  let totalMs = 0;

  let match: RegExpExecArray | null;
  while ((match = unitRegex.exec(normalized)) !== null) {
    const raw = match[0];
    if (!raw) continue;
    consumed += raw;
    const value = Number.parseFloat(match[1] ?? '');
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`invalid sleep duration token: ${token}`);
    }
    const unit = (match[2] ?? 's').toLowerCase();
    totalMs += convertUnitToMs(value, unit);
  }

  if (consumed.length !== normalized.length || totalMs <= 0) {
    throw new Error(`invalid sleep duration token: ${token}`);
  }

  return totalMs;
}

function convertUnitToMs(value: number, unit: string): number {
  if (unit === 'ms') return value;
  if (unit === 's') return value * 1_000;
  if (unit === 'm') return value * 60_000;
  if (unit === 'h') return value * 3_600_000;
  if (unit === 'd') return value * 86_400_000;
  throw new Error(`unsupported sleep unit: ${unit}`);
}

function formatDuration(ms: number): string {
  if (ms % 1_000 !== 0) return `${ms}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds}s`;
  if (seconds % 60 !== 0) return `${seconds}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes}m`;
  if (minutes % 60 !== 0) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours}h`;
  return `${hours / 24}d`;
}

function parseInjectPayload(record: Record<string, unknown>): SleepInjectInput {
  const agentId = typeof record.agentId === 'string' && record.agentId.trim().length > 0
    ? record.agentId.trim()
    : undefined;
  const sessionId = typeof record.sessionId === 'string' && record.sessionId.trim().length > 0
    ? record.sessionId.trim()
    : undefined;
  const projectPath = typeof record.projectPath === 'string' && record.projectPath.trim().length > 0
    ? record.projectPath.trim()
    : undefined;
  const channelId = typeof record.channelId === 'string' && record.channelId.trim().length > 0
    ? record.channelId.trim()
    : undefined;
  const prompt = typeof record.prompt === 'string' && record.prompt.trim().length > 0
    ? record.prompt.trim()
    : undefined;

  return {
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(projectPath ? { projectPath } : {}),
    ...(channelId ? { channelId } : {}),
    ...(prompt ? { prompt } : {}),
    ...(isProgressDelivery(record.progressDelivery) ? { progressDelivery: record.progressDelivery } : {}),
  };
}

function isProgressDelivery(value: unknown): value is ProgressDeliveryPolicy {
  return typeof value === 'object' && value !== null;
}
