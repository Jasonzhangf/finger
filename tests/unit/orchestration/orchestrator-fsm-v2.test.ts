import { describe, expect, it } from 'vitest';
import {
  OrchestratorFSMV2,
  sortResumeCandidates,
  type ResumeCandidate,
} from '../../../src/orchestration/orchestrator-fsm-v2.js';

describe('orchestrator-fsm-v2', () => {
  it('sorts resume candidates by executable -> priority -> updatedAt', () => {
    const input: ResumeCandidate[] = [
      { epicId: 'epic-c', priority: 2, updatedAt: '2026-01-01T00:00:00.000Z', blockedBy: ['dep-1'] },
      { epicId: 'epic-b', priority: 3, updatedAt: '2026-01-03T00:00:00.000Z' },
      { epicId: 'epic-a', priority: 1, updatedAt: '2026-01-02T00:00:00.000Z' },
      { epicId: 'epic-d', priority: 1, updatedAt: '2026-01-04T00:00:00.000Z', blockedBy: ['dep-2'] },
    ];

    const sorted = sortResumeCandidates(input);
    expect(sorted.map(item => item.epicId)).toEqual(['epic-a', 'epic-b', 'epic-d', 'epic-c']);
  });

  it('goes to resume_ask when probe finds resumable items and autoResume is off', () => {
    const fsm = new OrchestratorFSMV2();

    const boot = fsm.dispatch({ type: 'boot' });
    expect(boot.state).toBe('idle_probe_bd');
    expect(boot.commands[0].type).toBe('probe_bd_resumable');

    const probe = fsm.dispatch({
      type: 'bd_probe_result',
      resumable: [{ epicId: 'epic-1', priority: 1, updatedAt: '2026-02-01T00:00:00.000Z' }],
    });
    expect(probe.state).toBe('resume_ask');
    expect(probe.commands[0].type).toBe('ask_resume');
  });

  it('auto resumes when autoResume is enabled', () => {
    const fsm = new OrchestratorFSMV2({
      context: {
        autoResume: true,
      },
    });
    fsm.dispatch({ type: 'boot' });

    const probe = fsm.dispatch({
      type: 'bd_probe_result',
      resumable: [{ epicId: 'epic-2', priority: 2, updatedAt: '2026-02-01T00:00:00.000Z' }],
    });
    expect(probe.state).toBe('resume_plan');
    expect(probe.commands[0].type).toBe('load_resume_queue');
  });

  it('routes low confidence intake to ask_switch', () => {
    const fsm = new OrchestratorFSMV2({ state: 'intake' });
    const result = fsm.dispatch({
      type: 'intake_completed',
      intent: 'new_epic',
      conflict: false,
      confidence: 0.3,
      epicId: 'epic-low',
    });

    expect(result.state).toBe('ask_switch');
    expect(result.commands[0].type).toBe('clarify_low_confidence');
  });

  it('limits non-blocking plan review feedback to 3 rounds then proceeds', () => {
    const fsm = new OrchestratorFSMV2({
      state: 'plan_review',
    });

    const first = fsm.dispatch({ type: 'plan_review_feedback' });
    expect(first.state).toBe('plan_review');
    expect(first.context.reviewerFeedbackCount).toBe(1);

    const second = fsm.dispatch({ type: 'plan_review_feedback' });
    expect(second.state).toBe('plan_review');
    expect(second.context.reviewerFeedbackCount).toBe(2);

    const third = fsm.dispatch({ type: 'plan_review_feedback' });
    expect(third.state).toBe('observe');
    expect(third.context.reviewerFeedbackCount).toBe(0);
  });

  it('handles research branches: fanout more and enough info', () => {
    const fsm = new OrchestratorFSMV2({ state: 'research_eval' });

    const needMore = fsm.dispatch({
      type: 'research_evaluated',
      decision: 'need_more_results',
      missingSlots: 2,
    });
    expect(needMore.state).toBe('research_fanout');
    expect(needMore.commands[0].type).toBe('dispatch_research_agents');

    const enough = new OrchestratorFSMV2({ state: 'research_eval' }).dispatch({
      type: 'research_evaluated',
      decision: 'enough_info',
    });
    expect(enough.state).toBe('detail_design');
    expect(enough.commands[0].type).toBe('build_detail_design');
  });

  it('rejects claims without evidence in review_accept', () => {
    const fsm = new OrchestratorFSMV2({ state: 'review_accept' });
    const result = fsm.dispatch({
      type: 'review_result',
      decision: 'pass',
      claimsWithoutEvidence: 1,
    });

    expect(result.state).toBe('coder_handoff');
    expect(result.commands[0].type).toBe('reject_claim_without_evidence');
  });

  it('runs queue branch when schedule has busy resources', () => {
    const fsm = new OrchestratorFSMV2({ state: 'schedule' });
    const queued = fsm.dispatch({
      type: 'schedule_decided',
      confidence: 0.9,
      resourceBusy: true,
    });
    expect(queued.state).toBe('queue');

    const available = fsm.dispatch({ type: 'resource_available' });
    expect(available.state).toBe('dispatch');
    expect(available.commands[0].type).toBe('dispatch_coder');
  });

  it('completes end-to-end happy path through review pass', () => {
    const fsm = new OrchestratorFSMV2();

    fsm.dispatch({ type: 'boot' });
    fsm.dispatch({ type: 'bd_probe_result', resumable: [] });
    fsm.dispatch({ type: 'user_input', text: '实现 feature x' });
    fsm.dispatch({ type: 'intake_completed', intent: 'new_epic', conflict: false, confidence: 0.9, epicId: 'epic-1' });
    fsm.dispatch({ type: 'epic_synced', epicId: 'epic-1' });
    fsm.dispatch({ type: 'plan_baselined', confidence: 0.9 });
    fsm.dispatch({ type: 'observe_defined', researchExpected: 1 });
    fsm.dispatch({
      type: 'research_result',
      artifact: {
        agentId: 'research-1',
        summaryPath: 'output/research-1/summary.md',
        memoryPath: 'output/research-1/memory.jsonl',
      },
    });
    fsm.dispatch({ type: 'research_ingested' });
    fsm.dispatch({ type: 'research_evaluated', decision: 'enough_info' });
    fsm.dispatch({ type: 'detail_designed' });
    fsm.dispatch({ type: 'coder_handoff_ready' });
    fsm.dispatch({ type: 'schedule_decided', confidence: 0.9, resourceBusy: false });
    fsm.dispatch({ type: 'dispatch_result', ok: true });
    fsm.dispatch({ type: 'coder_result', claimCount: 2, evidenceCount: 2 });
    const review = fsm.dispatch({ type: 'review_result', decision: 'pass', claimsWithoutEvidence: 0 });

    expect(review.state).toBe('complete');
    expect(review.commands[0].type).toBe('finalize_delivery');
  });

  it('supports global cancel and fatal transitions from any non-terminal state', () => {
    const running = new OrchestratorFSMV2({ state: 'research_eval' });
    const cancelled = running.dispatch({ type: 'cancel' });
    expect(cancelled.state).toBe('cancelled');

    const another = new OrchestratorFSMV2({ state: 'schedule' });
    const failed = another.dispatch({ type: 'fatal_error', error: 'panic' });
    expect(failed.state).toBe('failed');
    expect(failed.context.lastError).toBe('panic');
  });
});
