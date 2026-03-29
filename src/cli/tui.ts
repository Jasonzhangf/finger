import path from 'path';
import type { Command } from 'commander';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';
import { startSessionPanel } from './session-panel.js';

const clog = createConsoleLikeLogger('TUI');

const DEFAULT_DAEMON_URL = process.env.FINGER_HUB_URL || 'http://localhost:9999';
const DEFAULT_WS_URL = process.env.FINGER_WS_URL || 'ws://localhost:9998';

interface TuiCommandOptions {
  url: string;
  wsUrl: string;
  project?: string;
  session?: string;
  events: boolean;
}

interface ProjectBootstrapResponse {
  success: boolean;
  projectPath: string;
  sessionId: string;
  agentId: string;
  monitorEnabled: boolean;
  createdSession: boolean;
  reusedSession: boolean;
  failedStage?: string;
  error?: string;
}

export function registerTuiCommand(program: Command): void {
  program
    .command('tui')
    .description('启动 TUI：自动绑定当前目录项目会话并接入 Project Agent')
    .option('-u, --url <url>', 'Daemon URL', DEFAULT_DAEMON_URL)
    .option('-w, --ws-url <url>', 'WebSocket URL', DEFAULT_WS_URL)
    .option('-p, --project <path>', 'Project path (default: cwd)')
    .option('-s, --session <id>', 'Use explicit session ID (override bootstrap result)')
    .option('--no-events', 'Disable WebSocket event stream')
    .action(async (options: TuiCommandOptions) => {
      const projectPath = path.resolve(options.project || process.cwd());
      const bootstrap = await bootstrapProject(options.url, projectPath);
      const sessionId = (options.session && options.session.trim().length > 0) ? options.session.trim() : bootstrap.sessionId;
      const targetAgent = bootstrap.agentId;

      clog.log(`Project: ${bootstrap.projectPath}`);
      clog.log(`Session: ${sessionId} (${bootstrap.reusedSession ? 'reused' : bootstrap.createdSession ? 'created' : 'resolved'})`);
      clog.log(`Target:  ${targetAgent}`);
      clog.log(`Monitor: ${bootstrap.monitorEnabled ? 'enabled' : 'disabled'}\n`);

      await startSessionPanel({
        daemonUrl: options.url,
        wsUrl: options.wsUrl,
        target: targetAgent,
        sessionId,
        events: options.events,
        projectAgentTarget: targetAgent,
        panelName: 'Finger TUI',
      });
    });
}

async function bootstrapProject(daemonUrl: string, projectPath: string): Promise<ProjectBootstrapResponse> {
  const response = await fetch(`${daemonUrl}/api/v1/projects/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectPath,
      createIfMissing: true,
      monitor: true,
    }),
  });

  const raw = await response.text();
  let payload: unknown = {};
  if (raw.trim().length > 0) {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Invalid JSON response from daemon (${response.status})`);
    }
  }

  if (!response.ok) {
    if (isRecord(payload) && typeof payload.error === 'string') {
      const failedStage = typeof payload.failedStage === 'string' ? payload.failedStage : '';
      throw new Error(failedStage ? `${payload.error} (stage=${failedStage})` : payload.error);
    }
    throw new Error(`HTTP ${response.status}`);
  }

  if (!isRecord(payload) || payload.success !== true) {
    throw new Error('Unexpected bootstrap response');
  }

  if (typeof payload.sessionId !== 'string' || payload.sessionId.trim().length === 0) {
    throw new Error('Bootstrap response missing sessionId');
  }
  if (typeof payload.agentId !== 'string' || payload.agentId.trim().length === 0) {
    throw new Error('Bootstrap response missing agentId');
  }

  return {
    success: true,
    projectPath: String(payload.projectPath ?? projectPath),
    sessionId: payload.sessionId,
    agentId: payload.agentId,
    monitorEnabled: payload.monitorEnabled === true,
    createdSession: payload.createdSession === true,
    reusedSession: payload.reusedSession === true,
    failedStage: typeof payload.failedStage === 'string' ? payload.failedStage : undefined,
    error: typeof payload.error === 'string' ? payload.error : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
