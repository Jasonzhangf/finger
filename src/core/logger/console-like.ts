import { inspect } from 'util';
import type { ModuleLogger } from './index.js';
import { logger } from './index.js';

const moduleCache = new Map<string, ModuleLogger>();

function getModuleLogger(moduleName: string): ModuleLogger {
  const existing = moduleCache.get(moduleName);
  if (existing) return existing;
  const created = logger.module(moduleName);
  moduleCache.set(moduleName, created);
  return created;
}

function normalizeArg(arg: unknown): unknown {
  if (arg instanceof Error) {
    return {
      name: arg.name,
      message: arg.message,
      stack: arg.stack,
    };
  }
  if (
    arg === null ||
    typeof arg === 'string' ||
    typeof arg === 'number' ||
    typeof arg === 'boolean'
  ) {
    return arg;
  }
  try {
    JSON.stringify(arg);
    return arg;
  } catch {
    return inspect(arg, { depth: 3, breakLength: 120 });
  }
}

function renderMessage(args: unknown[]): string {
  if (args.length === 0) return 'console call';
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      return inspect(arg, { depth: 2, breakLength: 120 });
    })
    .join(' ');
}

export function createConsoleLikeLogger(moduleName: string): {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  clear: () => void;
} {
  const mod = getModuleLogger(moduleName);

  const emit = (level: 'debug' | 'info' | 'warn' | 'error', args: unknown[]) => {
    const message = renderMessage(args);
    const data = { args: args.map(normalizeArg) };
    if (level === 'error') {
      const err = args.find((arg) => arg instanceof Error);
      mod.error(message, err instanceof Error ? err : undefined, data);
      return;
    }
    if (level === 'warn') {
      mod.warn(message, data);
      return;
    }
    if (level === 'debug') {
      mod.debug(message, data);
      return;
    }
    mod.info(message, data);
  };

  return {
    log: (...args: unknown[]) => emit('info', args),
    info: (...args: unknown[]) => emit('info', args),
    warn: (...args: unknown[]) => emit('warn', args),
    error: (...args: unknown[]) => emit('error', args),
    debug: (...args: unknown[]) => emit('debug', args),
    clear: () => {
      mod.info('console.clear called');
    },
  };
}
