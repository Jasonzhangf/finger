/**
 * Server Startup & Shutdown
 */

import type { Express } from 'express';
import type { Server } from 'http';
import { logger } from '../../core/logger.js';
import { initOpenClawGate, writePidFile, cleanupPidFile } from './server-lifecycle.js';

const log = logger.module('ServerStartup');

export interface ServerLifecycleDeps {
  chatCodexRunner: {
    listSessionStates(): Array<{ sessionId: string; providerId: string }>;
    interruptSession(sessionId: string, providerId: string): void;
  };
  clockInjector?: { stop(): void } | null;
  agentStatusSubscriber?: { stop(): void } | null;
  heartbeatScheduler?: { stop(): void } | null;
  progressMonitor?: { stop(): void } | null;
}

export function startServer(
  app: Express,
  host: string,
  port: number,
  deps: ServerLifecycleDeps,
): Server {
  const server = app.listen(port, host, () => {
    log.info(`Finger server running at http://${host}:${port}`);
    writePidFile();
    initOpenClawGate().catch((err) => {
      log.error('OpenClaw init error', err instanceof Error ? err : undefined);
    });
  });

  let shuttingDown = false;
  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Shutdown initiated: ${reason}`);
    try {
      const sessions = deps.chatCodexRunner.listSessionStates();
      for (const session of sessions) {
        try {
          deps.chatCodexRunner.interruptSession(session.sessionId, session.providerId);
    } catch (err) {
      log.warn('Failed to interrupt session: ' + (err instanceof Error ? err.message : String(err)));
    }
      }
  } catch (err) {
    log.warn('Failed to enumerate sessions during shutdown: ' + (err instanceof Error ? err.message : String(err)));
  }
    try {
      server.close(() => {
        process.exit(0);
      });
    } catch {
      process.exit(0);
    }
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('exit', () => {
    if (deps.clockInjector) deps.clockInjector.stop();
    if (deps.agentStatusSubscriber) deps.agentStatusSubscriber.stop();
    if (deps.heartbeatScheduler) deps.heartbeatScheduler.stop();
    if (deps.progressMonitor) deps.progressMonitor.stop();
    cleanupPidFile();
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`Port ${port} is still in use after cleanup`);
      process.exit(1);
    }
    log.error(`Failed to start: ${err.message}`);
    process.exit(1);
  });

  // Global error handlers to prevent silent crashes
  process.on('uncaughtException', (err: Error) => {
    log.error('Uncaught exception', err);
    try {
      const sessions = deps.chatCodexRunner.listSessionStates();
      for (const session of sessions) {
        try {
          deps.chatCodexRunner.interruptSession(session.sessionId, session.providerId);
        } catch {}
      }
    } catch {}
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    log.error('Unhandled rejection', undefined, {
      message,
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  return server;
}
