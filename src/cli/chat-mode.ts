import type { Command } from 'commander';
import { deriveWsUrl, startSessionPanel } from './session-panel.js';

const DEFAULT_DAEMON_URL = process.env.FINGER_HUB_URL || 'http://localhost:9999';
const DEFAULT_CHAT_TARGET = 'chat-gateway';

export function registerChatCommand(program: Command): void {
  program
    .command('chat')
    .description('Start interactive chat session (daemon IO gateway entry)')
    .option('-u, --url <url>', 'Daemon URL', DEFAULT_DAEMON_URL)
    .option('-w, --ws-url <url>', 'WebSocket URL')
    .option('-a, --agent <agentId>', 'Target gateway/agent module ID', DEFAULT_CHAT_TARGET)
    .option('-s, --session <id>', 'Use existing session ID')
    .option('--no-events', 'Disable WebSocket event stream')
    .action(
      async (options: { url: string; wsUrl?: string; agent: string; session?: string; events: boolean }) => {
        await startSessionPanel({
          daemonUrl: options.url,
          wsUrl: deriveWsUrl(options.url, options.wsUrl),
          target: options.agent,
          sessionId: options.session,
          events: options.events,
        });
      },
    );
}

export default registerChatCommand;
