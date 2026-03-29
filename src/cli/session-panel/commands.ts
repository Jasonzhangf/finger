import type { SessionPanelState } from './types.js';
import { clog } from './logger.js';
import { printHelp, printHistory } from './ui.js';
import {
  createSession,
  ensureSessionExists,
  loadSessionHistory,
  setCurrentSession,
} from './api.js';

export async function runPanelCommand(input: string, state: SessionPanelState, daemonUrl: string): Promise<boolean> {
  const [rawCommand, ...rest] = input.slice(1).trim().split(/\s+/);
  const command = rawCommand?.toLowerCase() || '';

  if (command === 'exit' || command === 'quit') {
    return false;
  }

  if (command === 'help') {
    printHelp(state);
    return true;
  }

  if (command === 'history') {
    printHistory(state.history);
    return true;
  }

  if (command === 'session') {
    clog.log(`Session: ${state.sessionId}`);
    clog.log(`Target:  ${state.target}`);
    if (typeof state.projectAgentTarget === 'string' && state.projectAgentTarget.trim().length > 0) {
      clog.log(`Project Agent: ${state.projectAgentTarget}`);
    }
    clog.log('');
    return true;
  }

  if (command === 'systemagent') {
    state.target = 'finger-system-agent';
    clog.log(`Target switched to: ${state.target}\n`);
    return true;
  }

  if (command === 'agent') {
    const projectTarget = state.projectAgentTarget?.trim();
    if (!projectTarget) {
      clog.log('No project agent bound for this panel. Use /target <moduleId>.\n');
      return true;
    }
    state.target = projectTarget;
    clog.log(`Target switched to project agent: ${state.target}\n`);
    return true;
  }

  if (command === 'target') {
    const nextTarget = rest.join(' ').trim();
    if (!nextTarget) {
      clog.log(`Current target: ${state.target}\n`);
      return true;
    }
    state.target = nextTarget;
    clog.log(`Target switched to: ${state.target}\n`);
    return true;
  }

  if (command === 'new') {
    const nextSession = await createSession(daemonUrl, rest.join(' ').trim() || undefined);
    await setCurrentSession(daemonUrl, nextSession.id);
    state.sessionId = nextSession.id;
    state.history = [];
    clog.log(`Switched to new session: ${state.sessionId}\n`);
    return true;
  }

  if (command === 'switch') {
    const nextSessionId = rest[0];
    if (!nextSessionId) {
      clog.log('Usage: /switch <sessionId>\n');
      return true;
    }
    await ensureSessionExists(daemonUrl, nextSessionId);
    await setCurrentSession(daemonUrl, nextSessionId);
    state.sessionId = nextSessionId;
    state.history = await loadSessionHistory(daemonUrl, state.sessionId);
    clog.log(`Switched to session: ${state.sessionId}\n`);
    return true;
  }

  clog.log(`Unknown command: /${command}`);
  printHelp(state);
  return true;
}
