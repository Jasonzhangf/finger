import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import type { WorkflowExecutionState, WorkflowStatus } from '../api/types.js';

const FINGER_HOME = path.join(homedir(), '.finger');
const SESSIONS_DIR = path.join(FINGER_HOME, 'sessions');

// Ensure directories exist
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// In-memory workflow state
const workflowStates = new Map<string, WorkflowExecutionState>();

const router = Router();

/**
 * GET /api/v1/workflow/:workflowId/state
 * Get current workflow execution state
 */
router.get('/:workflowId/state', (req, res) => {
  const { workflowId } = req.params;
  const state = workflowStates.get(workflowId);
  
  if (!state) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }
  
  res.json(state);
});

/**
 * POST /api/v1/workflow/:workflowId/pause
 * Pause workflow execution (hard pause)
 */
router.post('/:workflowId/pause', (req, res) => {
  const { workflowId } = req.params;
  const { hard = true } = req.body;
  
  const state = workflowStates.get(workflowId);
  if (!state) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }
  
  state.paused = true;
  state.status = 'paused';
  
  // Broadcast pause event
  broadcastToClients({
    type: 'workflow_update',
    payload: {
      workflowId,
      status: 'paused',
    },
  });
  
  res.json({ success: true, status: 'paused', hard });
});

/**
 * POST /api/v1/workflow/:workflowId/resume
 * Resume workflow execution
 */
router.post('/:workflowId/resume', (req, res) => {
  const { workflowId } = req.params;
  
  const state = workflowStates.get(workflowId);
  if (!state) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }
  
  state.paused = false;
  state.status = 'executing';
  
  // Broadcast resume event
  broadcastToClients({
    type: 'workflow_update',
    payload: {
      workflowId,
      status: 'executing',
    },
  });
  
  res.json({ success: true, status: 'executing' });
});

/**
 * POST /api/v1/workflow/:workflowId/input
 * Send user input to running workflow
 */
router.post('/:workflowId/input', (req, res) => {
  const { workflowId } = req.params;
  const { input } = req.body;
  
  const state = workflowStates.get(workflowId);
  if (!state) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }
  
  state.userInput = input;
  
  // Broadcast user input event
  broadcastToClients({
    type: 'workflow_update',
    payload: {
      workflowId,
      userInput: input,
    },
  });
  
  res.json({ success: true, input });
});

/**
 * GET /api/v1/workflow/:workflowId/report
 * Get task execution report
 */
router.get('/:workflowId/report', (req, res) => {
  const { workflowId } = req.params;
  const state = workflowStates.get(workflowId);
  
  if (!state) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }
  
  const report = generateTaskReport(state);
  res.json(report);
});

/**
 * POST /api/v1/agents/deploy
 * Deploy agent to session
 */
router.post('/api/v1/agents/deploy', (req, res) => {
  const { sessionId, config, scope = 'session' } = req.body;
  
  // Save agent config to session
  const agentConfigPath = path.join(SESSIONS_DIR, sessionId, 'agents', `${config.name}.json`);
  fs.mkdirSync(path.dirname(agentConfigPath), { recursive: true });
  fs.writeFileSync(agentConfigPath, JSON.stringify(config, null, 2));
  
  res.json({ 
    success: true, 
    message: `Agent deployed to ${scope} scope`,
    agentId: config.id || `${config.name}-${Date.now()}`,
  });
});

// Helper function to generate task report
function generateTaskReport(state: WorkflowExecutionState) {
  const completedTasks = state.tasks.filter((t) => t.status === 'completed');
  const failedTasks = state.tasks.filter((t) => t.status === 'failed');
  
  return {
    workflowId: state.workflowId,
    status: state.status,
    summary: {
      totalTasks: state.tasks.length,
      completed: completedTasks.length,
      failed: failedTasks.length,
      success: failedTasks.length === 0 && completedTasks.length === state.tasks.length,
      rounds: state.orchestrator.currentRound,
    },
    taskDetails: state.tasks.map((t) => ({
      taskId: t.id,
      description: t.description,
      status: t.status,
      assignee: t.assignee,
      output: t.result?.output,
      error: t.result?.error,
    })),
  };
}

// WebSocket broadcast helper (to be injected from main server)
let wsBroadcastFn: ((msg: unknown) => void) | null = null;

export function setWebSocketBroadcast(fn: (msg: unknown) => void) {
  wsBroadcastFn = fn;
}

function broadcastToClients(msg: unknown) {
  if (wsBroadcastFn) {
    wsBroadcastFn(msg);
  }
}

export { router as workflowRouter };
export { workflowStates };
