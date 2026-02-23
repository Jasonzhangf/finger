/**
 * CLI Error Codes and Error Handling
 */

export enum ExitCode {
  SUCCESS = 0,
  GENERAL_ERROR = 1,
  INVALID_ARGS = 2,
  CONNECTION_ERROR = 3,
  RESOURCE_MISSING = 4,
  TASK_FAILED = 5,
  USER_CANCELLED = 6,
  TIMEOUT = 7,
  PERMISSION_DENIED = 8,
  DAEMON_NOT_RUNNING = 9,
}

export class FingerError extends Error {
  constructor(
    message: string,
    public code: ExitCode,
    public details?: unknown
  ) {
    super(message);
    this.name = 'FingerError';
  }
}

export function exitWithError(error: unknown): never {
  if (error instanceof FingerError) {
    console.error(`Error: ${error.message}`);
    if (error.details) {
      console.error('Details:', error.details);
    }
    process.exit(error.code);
  } else {
    console.error('Unexpected error:', error);
    process.exit(ExitCode.GENERAL_ERROR);
  }
}

export function assertDaemonRunning(): void {
  // Check if daemon is running by trying to connect
  // Will be implemented with actual health check
}
