/**
 * Simple logger for agent modules
 */

const now = () => new Date().toISOString();

const logger = {
  debug: (message: string, ...args: unknown[]) => {
    console.log(`[${now()}] [DEBUG] ${message}`, ...args);
  },
  info: (message: string, ...args: unknown[]) => {
    console.log(`[${now()}] [INFO] ${message}`, ...args);
  },
  warn: (message: string, ...args: unknown[]) => {
    console.warn(`[${now()}] [WARN] ${message}`, ...args);
  },
  error: (message: string, ...args: unknown[]) => {
    console.error(`[${now()}] [ERROR] ${message}`, ...args);
  },
};

export default logger;
