import type { Express } from 'express';
import type { WebSocket } from 'ws';
import type { ResumableSessionManager, TaskProgress, SessionCheckpoint } from '../../orchestration/resumable-session.js';

export interface ResumableSessionRouteDeps {
  resumableSessionManager: ResumableSessionManager;
  wsClients: Set<WebSocket>;
}

export function registerResumableSessionRoutes(
  app: Express,
  deps: ResumableSessionRouteDeps,
): void {
  const { resumableSessionManager, wsClients } = deps;

  app.post('/api/v1/session/checkpoint', (req, res) => {
    const { sessionId, originalTask, taskProgress, agentStates, context } = req.body as {
      sessionId?: string;
      originalTask?: string;
      taskProgress?: TaskProgress[] | string;
      agentStates?: SessionCheckpoint['agentStates'] | Record<string, unknown>;
      context?: Record<string, unknown>;
    };
    if (!sessionId || !originalTask || !taskProgress) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    let normalizedProgress: TaskProgress[] | null = null;
    if (Array.isArray(taskProgress)) {
      normalizedProgress = taskProgress as TaskProgress[];
    } else if (typeof taskProgress === 'string') {
      try {
        const parsed = JSON.parse(taskProgress) as unknown;
        if (Array.isArray(parsed)) {
          normalizedProgress = parsed as TaskProgress[];
        }
      } catch {
        normalizedProgress = null;
      }
    }
    if (!normalizedProgress) {
      res.status(400).json({ error: 'taskProgress must be an array' });
      return;
    }

    const normalizedAgentStates = (agentStates && typeof agentStates === 'object')
      ? (agentStates as SessionCheckpoint['agentStates'])
      : {};

    const checkpoint = resumableSessionManager.createCheckpoint(
      sessionId,
      originalTask,
      normalizedProgress,
      normalizedAgentStates,
      context || {},
    );

    res.json({ success: true, checkpointId: checkpoint.checkpointId });
  });

  app.get('/api/v1/session/checkpoint/:checkpointId', (req, res) => {
    const checkpoint = resumableSessionManager.loadCheckpoint(req.params.checkpointId);
    if (!checkpoint) {
      res.status(404).json({ error: 'Checkpoint not found' });
      return;
    }
    res.json(checkpoint);
  });

  app.get('/api/v1/session/:sessionId/checkpoint/latest', (req, res) => {
    const checkpoint = resumableSessionManager.findLatestCheckpoint(req.params.sessionId);
    if (!checkpoint) {
      res.status(404).json({ error: 'No checkpoint found for session' });
      return;
    }

    const resumeContext = resumableSessionManager.buildResumeContext(checkpoint);
    res.json({
      checkpoint,
      resumeContext,
    });
  });

  app.post('/api/v1/session/resume', (req, res) => {
    const { sessionId, checkpointId } = req.body as { sessionId?: string; checkpointId?: string };

    let checkpoint: ReturnType<typeof resumableSessionManager.loadCheckpoint>;

    if (checkpointId) {
      checkpoint = resumableSessionManager.loadCheckpoint(checkpointId);
    } else {
      const normalizedSessionId = typeof sessionId === 'string' ? sessionId : '';
      checkpoint = resumableSessionManager.findLatestCheckpoint(normalizedSessionId);
    }

    if (!checkpoint) {
      res.status(404).json({ error: 'Checkpoint not found' });
      return;
    }

    const resumeContext = resumableSessionManager.buildResumeContext(checkpoint);

    const broadcastMsg = JSON.stringify({
      type: 'session_resume',
      payload: {
        sessionId: checkpoint.sessionId,
        checkpointId: checkpoint.checkpointId,
        progress: resumeContext.estimatedProgress,
        pendingTasks: checkpoint.pendingTaskIds.length,
      },
      timestamp: new Date().toISOString(),
    });

    for (const client of wsClients) {
      if (client.readyState === 1) client.send(broadcastMsg);
    }

    res.json({
      success: true,
      sessionId: checkpoint.sessionId,
      resumeContext,
    });
  });
}
