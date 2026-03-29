import type { Express } from 'express';
import path from 'path';
import type { BlockRegistry } from '../../core/registry.js';
import type { SessionManager } from '../../orchestration/session-manager.js';
import type { Session } from '../../orchestration/session-types.js';
import { setMonitorStatus } from '../../agents/finger-system-agent/registry.js';
import { logger } from '../../core/logger.js';

const log = logger.module('projects-route');

export interface ProjectRouteDeps {
  registry: BlockRegistry;
  sessionManager: SessionManager;
}

export function registerProjectRoutes(app: Express, deps: ProjectRouteDeps): void {
  app.post('/api/v1/projects/pick-directory', async (req, res) => {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : undefined;
    try {
      const result = await deps.registry.execute('project-1', 'pick-directory', { prompt });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/v1/projects/bootstrap', async (req, res) => {
    const projectPathRaw = typeof req.body?.projectPath === 'string' ? req.body.projectPath.trim() : '';
    const createIfMissing = req.body?.createIfMissing !== false;
    const shouldMonitor = req.body?.monitor !== false;

    if (!projectPathRaw) {
      res.status(400).json({ success: false, error: 'projectPath is required', failedStage: 'validate_project_path' });
      return;
    }

    const normalizedProjectPath = normalizeProjectPath(projectPathRaw);
    const sessionManager = deps.sessionManager;

    try {
      const existing = selectLatestExactProjectRootSession(sessionManager, normalizedProjectPath);
      let session = existing;
      let createdSession = false;
      let reusedSession = false;

      if (!session) {
        if (!createIfMissing) {
          res.status(404).json({
            success: false,
            error: 'No root session found for projectPath',
            failedStage: 'session_lookup',
          });
          return;
        }
        session = sessionManager.createSession(normalizedProjectPath, undefined, { allowReuse: true });
        createdSession = true;
      } else {
        reusedSession = true;
      }

      const setCurrent = sessionManager.setCurrentSession(session.id);
      if (!setCurrent) {
        res.status(400).json({
          success: false,
          error: 'Failed to set current session',
          failedStage: 'set_current_session',
        });
        return;
      }

      let monitorEnabled = false;
      let agentId = '';
      if (shouldMonitor) {
        const agent = await setMonitorStatus(normalizedProjectPath, true);
        monitorEnabled = agent.monitored === true;
        agentId = agent.agentId;
      } else {
        const fallbackProjectAgent = await setMonitorStatus(normalizedProjectPath, false);
        monitorEnabled = fallbackProjectAgent.monitored === true;
        agentId = fallbackProjectAgent.agentId;
      }

      if (!agentId) {
        res.status(500).json({
          success: false,
          error: 'Project agentId resolution failed',
          failedStage: 'monitor_registration',
        });
        return;
      }

      res.json({
        success: true,
        projectPath: normalizedProjectPath,
        sessionId: session.id,
        agentId,
        monitorEnabled,
        createdSession,
        reusedSession,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('project bootstrap failed', error instanceof Error ? error : undefined, {
        projectPath: normalizedProjectPath,
      });
      res.status(500).json({
        success: false,
        error: message,
        failedStage: 'bootstrap',
      });
    }
  });
}

export function selectLatestExactProjectRootSession(sessionManager: SessionManager, projectPath: string): Session | null {
  const normalizedProjectPath = normalizeProjectPath(projectPath);
  const roots = sessionManager.listRootSessions().filter((session) =>
    normalizeProjectPath(session.projectPath) === normalizedProjectPath && isRootSession(session));
  if (roots.length === 0) return null;
  roots.sort((a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime());
  return roots[0];
}

function isRootSession(session: Session): boolean {
  const context = session.context ?? {};
  return context.sessionTier !== 'runtime'
    && typeof context.parentSessionId !== 'string'
    && typeof context.rootSessionId !== 'string';
}

function normalizeProjectPath(projectPath: string): string {
  return path.resolve(projectPath.trim());
}
