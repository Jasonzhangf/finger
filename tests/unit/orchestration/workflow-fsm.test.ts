/**
 * Workflow FSM 单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { 
  WorkflowFSM, 
  TaskFSM, 
  AgentFSM,
  workflowFSMManager,
  getOrCreateWorkflowFSM,
  removeWorkflowFSM,
  type WorkflowState,
  type TaskState,
  type AgentState,
} from '../../../src/orchestration/workflow-fsm.js';

describe('WorkflowFSM', () => {
  beforeEach(() => {
    workflowFSMManager.clear();
  });

  it('should initialize with idle state', () => {
    const fsm = new WorkflowFSM({
      workflowId: 'wf-1',
      sessionId: 'session-1',
    });

    expect(fsm.getState()).toBe('idle');
  });

  it('should transition from idle to semantic_understanding on user_input_received', async () => {
    const fsm = new WorkflowFSM({
      workflowId: 'wf-1',
      sessionId: 'session-1',
    });

    const result = await fsm.trigger('user_input_received', {
      userTask: 'Test task',
    });

    expect(result).toBe(true);
    expect(fsm.getState()).toBe('semantic_understanding');
  });

  it('should transition from semantic_understanding to routing_decision on intent_analyzed', async () => {
    const fsm = new WorkflowFSM({
      workflowId: 'wf-1',
      sessionId: 'session-1',
      initialState: 'semantic_understanding',
    });

    const result = await fsm.trigger('intent_analyzed', {
      intentAnalysis: { normalizedIntent: { goal: 'test' } },
    });

    expect(result).toBe(true);
    expect(fsm.getState()).toBe('routing_decision');
  });

  it('should transition from routing_decision to plan_loop on full_replan', async () => {
    const fsm = new WorkflowFSM({
      workflowId: 'wf-1',
      sessionId: 'session-1',
      initialState: 'routing_decision',
    });

    const result = await fsm.trigger('routing_decided', {
      routingDecision: { route: 'full_replan' },
    });

    expect(result).toBe(true);
    expect(fsm.getState()).toBe('plan_loop');
  });

  it('should transition from routing_decision to execution on continue_execution', async () => {
    const fsm = new WorkflowFSM({
      workflowId: 'wf-1',
      sessionId: 'session-1',
      initialState: 'routing_decision',
    });

    const result = await fsm.trigger('routing_decided', {
      routingDecision: { route: 'continue_execution' },
    });

    expect(result).toBe(true);
    expect(fsm.getState()).toBe('execution');
  });

  it('should transition from routing_decision to wait_user_decision on new_task', async () => {
    const fsm = new WorkflowFSM({
      workflowId: 'wf-1',
      sessionId: 'session-1',
      initialState: 'routing_decision',
    });

    const result = await fsm.trigger('routing_decided', {
      routingDecision: { route: 'new_task' },
    });

    expect(result).toBe(true);
    expect(fsm.getState()).toBe('wait_user_decision');
  });

  it('should transition from plan_loop to execution on plan_created', async () => {
    const fsm = new WorkflowFSM({
      workflowId: 'wf-1',
      sessionId: 'session-1',
      initialState: 'plan_loop',
    });

    const result = await fsm.trigger('plan_created', {
      plan: { tasks: [] },
    });

    expect(result).toBe(true);
    expect(fsm.getState()).toBe('execution');
  });

  it('should transition from execution to review on task_completed', async () => {
    const fsm = new WorkflowFSM({
      workflowId: 'wf-1',
      sessionId: 'session-1',
      initialState: 'execution',
    });

    const result = await fsm.trigger('task_completed', {
      tasks: [{ id: 't1', status: 'done' }],
    });

    expect(result).toBe(true);
    expect(fsm.getState()).toBe('review');
  });

  it('should transition from review to execution on review_passed', async () => {
    const fsm = new WorkflowFSM({
      workflowId: 'wf-1',
      sessionId: 'session-1',
      initialState: 'review',
    });

    const result = await fsm.trigger('review_passed');

    expect(result).toBe(true);
    expect(fsm.getState()).toBe('execution');
  });

  it('should transition from review to plan_loop on review_rejected', async () => {
    const fsm = new WorkflowFSM({
      workflowId: 'wf-1',
      sessionId: 'session-1',
      initialState: 'review',
    });

    const result = await fsm.trigger('review_rejected');

    expect(result).toBe(true);
    expect(fsm.getState()).toBe('plan_loop');
  });

  it('should transition to paused on pause_requested from any state', async () => {
    const states: WorkflowState[] = ['idle', 'execution', 'review', 'plan_loop'];

    for (const initialState of states) {
      const fsm = new WorkflowFSM({
        workflowId: 'wf-1',
        sessionId: 'session-1',
        initialState,
      });

      const result = await fsm.trigger('pause_requested');

      expect(result).toBe(true);
      expect(fsm.getState()).toBe('paused');
    }
  });

  it('should transition from paused to semantic_understanding on user_input_received', async () => {
    const fsm = new WorkflowFSM({
      workflowId: 'wf-1',
      sessionId: 'session-1',
      initialState: 'paused',
    });

    const result = await fsm.trigger('user_input_received');

    expect(result).toBe(true);
    expect(fsm.getState()).toBe('semantic_understanding');
  });

  it('should track state history', async () => {
    const fsm = new WorkflowFSM({
      workflowId: 'wf-1',
      sessionId: 'session-1',
    });

    await fsm.trigger('user_input_received');
    await fsm.trigger('intent_analyzed');
    await fsm.trigger('routing_decided', {
      routingDecision: { route: 'continue_execution' },
    });

    const history = fsm.getStateHistory();

    expect(history.length).toBe(3);
    expect(history[0].state).toBe('semantic_understanding');
    expect(history[1].state).toBe('routing_decision');
    expect(history[2].state).toBe('execution');
  });

  it('should update context', async () => {
    const fsm = new WorkflowFSM({
      workflowId: 'wf-1',
      sessionId: 'session-1',
    });

    fsm.updateContext({ userTask: 'Test task' });

    const context = fsm.getContext();
    expect(context.userTask).toBe('Test task');
  });

  it('should reset to initial state', async () => {
    const fsm = new WorkflowFSM({
      workflowId: 'wf-1',
      sessionId: 'session-1',
    });

    await fsm.trigger('user_input_received');
    expect(fsm.getState()).toBe('semantic_understanding');

    fsm.reset();
    expect(fsm.getState()).toBe('idle');
    expect(fsm.getStateHistory().length).toBe(0);
  });
});

describe('TaskFSM', () => {
  it('should initialize with created state', () => {
    const taskFSM = new TaskFSM('task-1');
    expect(taskFSM.getState()).toBe('created');
  });

  it('should transition through normal flow', () => {
    const taskFSM = new TaskFSM('task-1');

    expect(taskFSM.transition('deps_satisfied')).toBe(true);
    expect(taskFSM.getState()).toBe('ready');

    expect(taskFSM.transition('orchestrator_dispatch')).toBe(true);
    expect(taskFSM.getState()).toBe('dispatching');

    expect(taskFSM.transition('dispatch_ack')).toBe(true);
    expect(taskFSM.getState()).toBe('dispatched');

    expect(taskFSM.transition('task_execution_started')).toBe(true);
    expect(taskFSM.getState()).toBe('running');

    expect(taskFSM.transition('task_execution_result_success')).toBe(true);
    expect(taskFSM.getState()).toBe('execution_succeeded');

    expect(taskFSM.transition('review_requested')).toBe(true);
    expect(taskFSM.getState()).toBe('reviewing');

    expect(taskFSM.transition('review_pass')).toBe(true);
    expect(taskFSM.getState()).toBe('done');
  });

  it('should handle dispatch failure', () => {
    const taskFSM = new TaskFSM('task-1');

    taskFSM.transition('deps_satisfied');
    taskFSM.transition('orchestrator_dispatch');

    expect(taskFSM.transition('dispatch_nack')).toBe(true);
    expect(taskFSM.getState()).toBe('dispatch_failed');
  });

  it('should handle execution failure and retry', () => {
    const taskFSM = new TaskFSM('task-1');

    taskFSM.transition('deps_satisfied');
    taskFSM.transition('orchestrator_dispatch');
    taskFSM.transition('dispatch_ack');
    taskFSM.transition('task_execution_started');

    expect(taskFSM.transition('task_execution_result_failure')).toBe(true);
    expect(taskFSM.getState()).toBe('execution_failed');

    expect(taskFSM.transition('retry_or_reassign')).toBe(true);
    expect(taskFSM.getState()).toBe('ready');
  });

  it('should handle review rejection', () => {
    const taskFSM = new TaskFSM('task-1');

    taskFSM.transition('deps_satisfied');
    taskFSM.transition('orchestrator_dispatch');
    taskFSM.transition('dispatch_ack');
    taskFSM.transition('task_execution_started');
    taskFSM.transition('task_execution_result_success');
    taskFSM.transition('review_requested');

    expect(taskFSM.transition('review_reject')).toBe(true);
    expect(taskFSM.getState()).toBe('rework_required');

    expect(taskFSM.transition('replan_or_retry')).toBe(true);
    expect(taskFSM.getState()).toBe('ready');
  });
});

describe('AgentFSM', () => {
  it('should initialize with idle state', () => {
    const agentFSM = new AgentFSM('agent-1');
    expect(agentFSM.getState()).toBe('idle');
  });

  it('should transition through normal flow', () => {
    const agentFSM = new AgentFSM('agent-1');

    expect(agentFSM.transition('dispatch_ack')).toBe(true);
    expect(agentFSM.getState()).toBe('reserved');

    expect(agentFSM.transition('task_execution_started')).toBe(true);
    expect(agentFSM.getState()).toBe('running');

    expect(agentFSM.transition('task_execution_result_success')).toBe(true);
    expect(agentFSM.getState()).toBe('idle');
  });

  it('should handle execution failure', () => {
    const agentFSM = new AgentFSM('agent-1');

    agentFSM.transition('dispatch_ack');
    agentFSM.transition('task_execution_started');

    expect(agentFSM.transition('task_execution_result_failure')).toBe(true);
    expect(agentFSM.getState()).toBe('error');

    expect(agentFSM.transition('recover_or_reset')).toBe(true);
    expect(agentFSM.getState()).toBe('idle');
  });

  it('should handle multiple steps during execution', () => {
    const agentFSM = new AgentFSM('agent-1');

    agentFSM.transition('dispatch_ack');
    agentFSM.transition('task_execution_started');

    // Multiple steps during execution
    expect(agentFSM.transition('agent_step_completed')).toBe(true);
    expect(agentFSM.getState()).toBe('running');

    expect(agentFSM.transition('agent_step_completed')).toBe(true);
    expect(agentFSM.getState()).toBe('running');

    expect(agentFSM.transition('task_execution_result_success')).toBe(true);
    expect(agentFSM.getState()).toBe('idle');
  });
});

describe('WorkflowFSM Manager', () => {
  it('should create and cache FSM instances', () => {
    const fsm1 = getOrCreateWorkflowFSM({
      workflowId: 'wf-1',
      sessionId: 'session-1',
    });

    const fsm2 = getOrCreateWorkflowFSM({
      workflowId: 'wf-1',
      sessionId: 'session-1',
    });

    expect(fsm1).toBe(fsm2);
    expect(workflowFSMManager.has('wf-1')).toBe(true);
  });

  it('should remove FSM instances', () => {
    getOrCreateWorkflowFSM({
      workflowId: 'wf-1',
      sessionId: 'session-1',
    });

    removeWorkflowFSM('wf-1');

    expect(workflowFSMManager.has('wf-1')).toBe(false);
  });
});
