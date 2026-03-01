import type { Express } from 'express';
import type { WebSocketServer } from 'ws';
import {
  getAllStateSnapshots,
  getStateSnapshot,
  initializeStateBridge,
  registerWebSocketClient,
  unregisterWebSocketClient,
} from '../../orchestration/workflow-state-bridge.js';

export interface WorkflowStateRouteDeps {
  wss: WebSocketServer;
}

export function registerWorkflowStateRoutes(app: Express, deps: WorkflowStateRouteDeps): void {
  const { wss } = deps;

  initializeStateBridge();

  app.get('/api/v1/workflows/:workflowId/state', (req, res) => {
    const snapshot = getStateSnapshot(req.params.workflowId);
    if (!snapshot) {
      res.status(404).json({ error: 'State snapshot not found' });
      return;
    }
    res.json(snapshot);
  });

  app.get('/api/v1/workflows/state', (_req, res) => {
    const snapshots = getAllStateSnapshots();
    res.json({ snapshots });
  });

  wss.on('connection', (ws) => {
    registerWebSocketClient(ws);

    ws.on('close', () => {
      unregisterWebSocketClient(ws);
    });
  });

  console.log('[Server] State Bridge integration enabled');
}
