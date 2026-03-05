import type { Express } from 'express';
import type { SessionManager } from '../../orchestration/session-manager.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { FINGER_SOURCE_ROOT } from '../../core/source-root.js';

export interface RuntimePathDeps {
  sessionManager: SessionManager;
}

export function registerRuntimePathRoutes(app: Express, deps: RuntimePathDeps): void {
  app.get('/api/v1/runtime/paths', (_req, res) => {
    const current = deps.sessionManager.getCurrentSession();
    res.json({
      success: true,
      workingProjectPath: current?.projectPath ?? null,
      sourceProjectPath: FINGER_SOURCE_ROOT,
      sessionPath: current?.sessionWorkspaceRoot ?? null,
      sessionsRoot: FINGER_PATHS.sessions.dir,
    });
  });
}
