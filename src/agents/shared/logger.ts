/**
 * Shared logger for legacy agent modules.
 *
 * Kept as compatibility layer, backed by unified FingerLogger.
 */

import { createConsoleLikeLogger } from '../../core/logger/console-like.js';

const base = createConsoleLikeLogger('AgentsShared');

const logger = {
  debug: (message: string, ...args: unknown[]) => {
    base.debug(message, ...args);
  },
  info: (message: string, ...args: unknown[]) => {
    base.info(message, ...args);
  },
  warn: (message: string, ...args: unknown[]) => {
    base.warn(message, ...args);
  },
  error: (message: string, ...args: unknown[]) => {
    base.error(message, ...args);
  },
};

export default logger;

