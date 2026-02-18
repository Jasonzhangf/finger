import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ResumableSessionManager, determineResumePhase, type SessionCheckpoint, type PhaseHistoryEntry } from '../../src/orchestration/resumable-session.js';

const FINGER_HOME = path.join(os.homedir(), '.finger');
const SESSION_STATE_DIR = path.join(FINGER_HOME, 'session-states');

describe('Orchestrator Phase Resume Integration', () => {
  let manager: ResumableSessionManager;
  let testSessionId: string;
  
  beforeEach(() => {
    manager = new ResumableSessionManager();
    testSessionId = `test-resume-${Date.now()}`;
    if (!fs.existsSync(SESSION_STATE_DIR)) {
      fs.mkdirSync(SESSION_STATE_DIR, { recursive: true });
    }
  });
  
  afterEach(() => {
    // Cleanup test checkpoints
    const files = fs.readdirSync(SESSION_STATE_DIR);
    for (const file of files) {
      if (file.startsWith(testSessionId)) {
        fs.unlinkSync(path.join(SESSION_STATE_DIR, file));
      }
    }
  });
  
  it('should resume from HIGH_DESIGN checkpoint and continue through phases', async () => {
    // Phase 1: Create checkpoint at HIGH_DESIGN (simulating interruption after HIGH_DESIGN)
    const highDesignCheckpoint = manager.createCheckpoint(
      testSessionId,
      'Test task for phase resume',
      [
        { taskId: 'task-1', description: 'Design architecture', status: 'completed', startedAt: new Date().toISOString() },
        { taskId: 'task-2', description: 'Implement feature', status: 'pending' },
      ],
      { 'agent-1': { agentId: 'agent-1', status: 'high_design', round: 1 } },
      { phase: 'high_design', highDesign: 'System architecture defined' },
      [{ phase: 'understanding', timestamp: new Date().toISOString(), action: 'start' },
       { phase: 'high_design', timestamp: new Date().toISOString(), action: 'design_completed' }]
    );
    
    expect(highDesignCheckpoint.checkpointId).toBeDefined();
    expect(highDesignCheckpoint.phaseHistory).toHaveLength(2);
    
    // Phase 2: Simulate interruption - retrieve the checkpoint
    const latestCheckpoint = manager.findLatestCheckpoint(testSessionId);
    expect(latestCheckpoint).not.toBeNull();
    
    // Phase 3: Determine resume phase
    const resumePhase = determineResumePhase(latestCheckpoint!);
    expect(resumePhase).toBe('high_design');
    
    // Phase 4: Simulate continuing execution - create DETAIL_DESIGN checkpoint
    const detailDesignCheckpoint = manager.createCheckpoint(
      testSessionId,
      'Test task for phase resume',
      [
        { taskId: 'task-1', description: 'Design architecture', status: 'completed', startedAt: new Date().toISOString() },
        { taskId: 'task-2', description: 'Implement feature', status: 'in_progress', startedAt: new Date().toISOString() },
      ],
      { 'agent-1': { agentId: 'agent-1', status: 'detail_design', round: 2 } },
      { 
        phase: 'detail_design', 
        highDesign: 'System architecture defined',
        detailDesign: 'Detailed component specs'
      },
      [...(latestCheckpoint!.phaseHistory || []),
       { phase: 'detail_design', timestamp: new Date().toISOString(), action: 'detail_design_completed' }]
    );
    
    expect(detailDesignCheckpoint.phaseHistory).toHaveLength(3);
    
    // Phase 5: Continue to VERIFY
    const verifyCheckpoint = manager.createCheckpoint(
      testSessionId,
      'Test task for phase resume',
      [
        { taskId: 'task-1', description: 'Design architecture', status: 'completed', startedAt: new Date().toISOString() },
        { taskId: 'task-2', description: 'Implement feature', status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
      ],
      { 'agent-1': { agentId: 'agent-1', status: 'verify', round: 3 } },
      { 
        phase: 'verify', 
        highDesign: 'System architecture defined',
        detailDesign: 'Detailed component specs',
        deliverables: ['feature.ts']
      },
      [...(detailDesignCheckpoint.phaseHistory || []),
       { phase: 'deliverables', timestamp: new Date().toISOString(), action: 'deliverables_completed' },
       { phase: 'verify', timestamp: new Date().toISOString(), action: 'verify_started' }]
    );
    
    expect(verifyCheckpoint.phaseHistory).toHaveLength(5);
    
    // Final: Verify resume from VERIFY phase
    const finalResumePhase = determineResumePhase(verifyCheckpoint);
    expect(finalResumePhase).toBe('verify');
  });
  
  it('should keep only last 10 checkpoints after cleanup', async () => {
    // Create 15 checkpoints
    for (let i = 0; i < 15; i++) {
      manager.createCheckpoint(
        testSessionId,
        `Test task ${i}`,
        [{ taskId: `task-${i}`, description: `Task ${i}`, status: 'pending' }],
        {},
        { phase: 'understanding', round: i },
        [{ phase: 'understanding', timestamp: new Date().toISOString(), action: `checkpoint-${i}` }]
      );
    }
    
    // Verify 15 checkpoints exist
    const checkpointsBeforeCleanup = fs.readdirSync(SESSION_STATE_DIR)
      .filter(f => f.startsWith(testSessionId));
    expect(checkpointsBeforeCleanup.length).toBe(15);
    
    // Run cleanup
    const deletedCount = manager.cleanupOldCheckpoints(testSessionId, 10);
    expect(deletedCount).toBe(5);
    
    // Verify only 10 remain
    const checkpointsAfterCleanup = fs.readdirSync(SESSION_STATE_DIR)
      .filter(f => f.startsWith(testSessionId));
    expect(checkpointsAfterCleanup.length).toBe(10);
    
    // Verify the latest checkpoint is preserved
    const latestCheckpoint = manager.findLatestCheckpoint(testSessionId);
    expect(latestCheckpoint).not.toBeNull();
    expect(latestCheckpoint!.context).toHaveProperty('round', 14);
  });
  
  it('should correctly determine resume phase from phaseHistory', () => {
    const testCases: { phaseHistory: PhaseHistoryEntry[]; expectedPhase: string }[] = [
      {
        phaseHistory: [{ phase: 'understanding', timestamp: '2024-01-01T00:00:00Z', action: 'start' }],
        expectedPhase: 'understanding'
      },
      {
        phaseHistory: [
          { phase: 'understanding', timestamp: '2024-01-01T00:00:00Z', action: 'start' },
          { phase: 'high_design', timestamp: '2024-01-01T00:01:00Z', action: 'completed' },
          { phase: 'detail_design', timestamp: '2024-01-01T00:02:00Z', action: 'completed' }
        ],
        expectedPhase: 'detail_design'
      },
      {
        phaseHistory: [
          { phase: 'plan', timestamp: '2024-01-01T00:00:00Z', action: 'start' },
          { phase: 'parallel_dispatch', timestamp: '2024-01-01T00:01:00Z', action: 'dispatching' }
        ],
        expectedPhase: 'parallel_dispatch'
      }
    ];
    
    for (const { phaseHistory, expectedPhase } of testCases) {
      const checkpoint: SessionCheckpoint = {
        checkpointId: 'test',
        sessionId: testSessionId,
        timestamp: new Date().toISOString(),
        failedTaskIds: [],
        taskProgress: [],
        completedTaskIds: [],
        pendingTaskIds: [],
        agentStates: {},
        phaseHistory,
        context: {}
      };
      
      expect(determineResumePhase(checkpoint)).toBe(expectedPhase);
    }
  });
});
