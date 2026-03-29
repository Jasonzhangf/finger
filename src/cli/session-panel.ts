import type { Command } from 'commander';
import { DEFAULT_DAEMON_URL, DEFAULT_GATEWAY_TARGET, DEFAULT_WS_URL } from './session-panel/constants.js';
import { startSessionPanel } from './session-panel/core.js';
import { deriveWsUrl } from './session-panel/events.js';
import { extractPanelReply } from './session-panel/reply.js';

export type { SessionPanelOptions } from './session-panel/types.js';

export function registerSessionPanelCommand(program: Command): void {
  program
    .command('session-panel')
    .description('会话面板 CLI（作为 daemon 的统一 IO 入口）')
    .option('-u, --url <url>', 'Daemon URL', DEFAULT_DAEMON_URL)
    .option('-w, --ws-url <url>', 'WebSocket URL', DEFAULT_WS_URL)
    .option('-t, --target <moduleId>', 'Gateway/agent target module ID', DEFAULT_GATEWAY_TARGET)
    .option('-s, --session <id>', 'Use existing session ID')
    .option('--no-events', 'Disable WebSocket event stream')
    .action(async (options: { url: string; wsUrl: string; target: string; session?: string; events: boolean }) => {
      await startSessionPanel({
        daemonUrl: options.url,
        wsUrl: options.wsUrl,
        target: options.target,
        sessionId: options.session,
        events: options.events,
      });
    });
}

export { startSessionPanel, deriveWsUrl, extractPanelReply };
