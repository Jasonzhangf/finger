import type { Express } from 'express';
import type { SessionManager } from '../../orchestration/session-manager.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { FINGER_SOURCE_ROOT } from '../../core/source-root.js';
import { SYSTEM_PROJECT_PATH } from '../../agents/finger-system-agent/index.js';
import { asString } from '../common/strings.js';
import { isObjectRecord } from '../common/object.js';

export interface RuntimePathDeps {
  sessionManager: SessionManager;
}

export function registerRuntimePathRoutes(app: Express, deps: RuntimePathDeps): void {
  app.get('/api/v1/runtime/paths', (req, res) => {
    const requestedId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : '';
    const current = requestedId
      ? deps.sessionManager.getSession(requestedId)
      : deps.sessionManager.getCurrentSession();
    const context = current && isObjectRecord(current.context) ? current.context : {};
    const sessionTier = asString(context.sessionTier);
    const effectiveProjectPath = current?.projectPath ?? null;
    const isSystemSession = effectiveProjectPath === SYSTEM_PROJECT_PATH || sessionTier === 'system';
    const sessionWorkspaceRoot = asString(context.sessionWorkspaceRoot);
    const agentSessionWorkspace = asString(context.agentSessionWorkspace);
    const resolvedWorkspaceRoot = current
      ? deps.sessionManager.resolveSessionWorkspaceRoot(current.id)
      : null;
    const sessionPath = sessionTier === 'runtime' && agentSessionWorkspace
      ? agentSessionWorkspace
      : sessionWorkspaceRoot || resolvedWorkspaceRoot;
    res.json({
      success: true,
      workingProjectPath: effectiveProjectPath,
      isSystemSession,
      sourceProjectPath: FINGER_SOURCE_ROOT,
      sessionPath,
      sessionsRoot: FINGER_PATHS.sessions.dir,
    });
  });
}
