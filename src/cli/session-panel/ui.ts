import type { Interface } from 'readline';
import type { PanelHistoryEntry, SessionPanelState } from './types.js';
import { clog } from './logger.js';

export function printHeader(state: SessionPanelState): void {
  const panelName = state.panelName?.trim() || 'Session Panel (CLI IO Gateway)';
  clog.log(`\n${panelName}`);
  clog.log('------------------------------');
  clog.log(`Session: ${state.sessionId}`);
  clog.log(`Target:  ${state.target}`);
  if (typeof state.projectAgentTarget === 'string' && state.projectAgentTarget.trim().length > 0) {
    clog.log(`Project Agent: ${state.projectAgentTarget}`);
  }
  printHelp(state);
}

export function printHelp(state?: Pick<SessionPanelState, 'projectAgentTarget'>): void {
  const hasProjectAgent = typeof state?.projectAgentTarget === 'string' && state.projectAgentTarget.trim().length > 0;
  clog.log('Commands:');
  clog.log('  /help                 Show this help');
  clog.log('  /history              Show local conversation history');
  clog.log('  /session              Show current session and target');
  clog.log('  /target <moduleId>    Switch target gateway/agent');
  if (hasProjectAgent) {
    clog.log('  /systemagent          Switch target to finger-system-agent');
    clog.log('  /agent                Switch target back to current project agent');
  }
  clog.log('  /new [name]           Create and switch to new session');
  clog.log('  /switch <sessionId>   Switch to existing session');
  clog.log('  /exit                 Exit panel');
  clog.log('');
}

export function printHistory(history: PanelHistoryEntry[]): void {
  if (history.length === 0) {
    clog.log('History is empty.\n');
    return;
  }

  clog.log('History:');
  for (const item of history) {
    const prefix = item.role === 'user' ? 'You' : 'Agent';
    clog.log(`${prefix}: ${item.content}`);
  }
  clog.log('');
}

export function safePrompt(rl: Interface): void {
  const status = rl as unknown as { closed?: boolean };
  if (status.closed) {
    return;
  }

  try {
    rl.prompt();
  } catch (error) {
    const maybeNodeError = error as { code?: string };
    if (maybeNodeError.code !== 'ERR_USE_AFTER_CLOSE') {
      throw error;
    }
  }
}
