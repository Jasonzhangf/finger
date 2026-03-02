import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { ChatCodexLoopEvent } from '../../agents/finger-general/finger-general-module.js';
import { ensureDir } from '../../core/finger-paths.js';
import type { SessionWorkspaceManager } from './session-workspaces.js';

export interface SessionLoggingDeps {
  sessionWorkspaces: SessionWorkspaceManager;
  primaryOrchestratorAgentId: string;
  errorSampleDir: string;
}

export function createSessionLoggingHelpers(deps: SessionLoggingDeps) {
  const { sessionWorkspaces, primaryOrchestratorAgentId, errorSampleDir } = deps;

  const resolveSessionLoopLogPath = (sessionId: string): string => {
    const dirs = sessionWorkspaces.resolveSessionWorkspaceDirsForMessage(sessionId);
    const diagnosticsDir = ensureDir(join(dirs.sessionWorkspaceRoot, 'diagnostics'));
    return join(diagnosticsDir, `${primaryOrchestratorAgentId}.loop.jsonl`);
  };

  const appendSessionLoopLog = (event: ChatCodexLoopEvent): void => {
    try {
      const logPath = resolveSessionLoopLogPath(event.sessionId);
      appendFileSync(logPath, `${JSON.stringify(event)}\n`, 'utf-8');
    } catch (error) {
      console.error('[Server] append session loop log failed:', error);
    }
  };

  const writeMessageErrorSample = (payload: Record<string, unknown>): void => {
    try {
      if (!existsSync(errorSampleDir)) {
        mkdirSync(errorSampleDir, { recursive: true });
      }
      const now = new Date();
      const fileName = `message-error-${now.toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}.json`;
      const filePath = join(errorSampleDir, fileName);
      const content = {
        timestamp: now.toISOString(),
        localTime: now.toLocaleString(),
        ...payload,
      };
      appendFileSync(filePath, `${JSON.stringify(content, null, 2)}\n`, 'utf-8');
    } catch (error) {
      console.error('[Server] write message error sample failed:', error);
    }
  };

  return {
    resolveSessionLoopLogPath,
    appendSessionLoopLog,
    writeMessageErrorSample,
  };
}
