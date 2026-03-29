import { createInterface } from 'readline';
import type { SessionPanelOptions, SessionPanelState } from './types.js';
import { clog } from './logger.js';
import { ensureDaemonHealthy, loadSessionHistory, resolveSessionId, sendPanelInput } from './api.js';
import { connectEventStream, deriveWsUrl } from './events.js';
import { runPanelCommand } from './commands.js';
import { printHeader, safePrompt } from './ui.js';

export async function startSessionPanel(options: SessionPanelOptions): Promise<void> {
  await ensureDaemonHealthy(options.daemonUrl);

  const state: SessionPanelState = {
    target: options.target,
    sessionId: await resolveSessionId(options.daemonUrl, options.sessionId),
    history: [],
    projectAgentTarget: options.projectAgentTarget,
    panelName: options.panelName,
  };

  state.history = await loadSessionHistory(options.daemonUrl, state.sessionId);

  printHeader(state);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You: ',
  });

  const resolvedWsUrl = deriveWsUrl(options.daemonUrl, options.wsUrl);
  const ws = options.events ? connectEventStream(resolvedWsUrl, state, rl) : null;

  safePrompt(rl);

  for await (const line of rl) {
    const input = line.trim();
    if (input.length === 0) {
      safePrompt(rl);
      continue;
    }

    if (input.startsWith('/')) {
      const keepRunning = await runPanelCommand(input, state, options.daemonUrl);
      if (!keepRunning) break;
      safePrompt(rl);
      continue;
    }

    state.history.push({ role: 'user', content: input });
    try {
      const reply = await sendPanelInput(options.daemonUrl, state.target, state.sessionId, input, state.history);
      clog.log(`Agent: ${reply}\n`);
      state.history.push({ role: 'assistant', content: reply });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      clog.error(`Error: ${message}\n`);
    }
    safePrompt(rl);
  }

  if (ws) ws.close();
  const status = rl as unknown as { closed?: boolean };
  if (!status.closed) rl.close();
  process.stdin.pause();
}
