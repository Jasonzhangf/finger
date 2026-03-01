export type OrchestratorV2State =
  | 'boot'
  | 'idle_probe_bd'
  | 'resume_ask'
  | 'resume_plan'
  | 'idle'
  | 'intake'
  | 'ask_switch'
  | 'epic_sync'
  | 'plan_baseline'
  | 'plan_review'
  | 'observe'
  | 'research_fanout'
  | 'wait_others'
  | 'research_ingest'
  | 'research_eval'
  | 'detail_design'
  | 'coder_handoff'
  | 'schedule'
  | 'queue'
  | 'dispatch'
  | 'coder_exec'
  | 'review_accept'
  | 'replan_patch'
  | 'complete'
  | 'cancelled'
  | 'failed';

export type IntakeIntent = 'continue' | 'modify' | 'new_epic';
export type ResumeDecision = 'yes' | 'no';
export type SwitchDecision = 'switch' | 'keep' | 'merge' | 'clarified';
export type ResearchDecision = 'need_more_results' | 'need_replan' | 'enough_info';
export type ReviewDecision = 'pass' | 'retry' | 'replan';

export interface ResumeCandidate {
  epicId: string;
  priority: number;
  updatedAt: string;
  blockedBy?: string[];
}

export interface ResearchArtifactRef {
  agentId: string;
  summaryPath: string;
  memoryPath: string;
  operationLogPath?: string;
}

export interface OrchestratorV2Context {
  autoResume: boolean;
  confidence: number;
  currentEpicId?: string;
  pendingEpicId?: string;
  resumeCandidates: ResumeCandidate[];
  resumeQueue: ResumeCandidate[];
  reviewerFeedbackCount: number;
  maxReviewerFeedbackCount: number;
  researchExpected: number;
  researchReceived: number;
  researchArtifacts: ResearchArtifactRef[];
  lastError?: string;
}

export interface OrchestratorV2Snapshot {
  state: OrchestratorV2State;
  context: OrchestratorV2Context;
}

export type OrchestratorV2CommandType =
  | 'probe_bd_resumable'
  | 'ask_resume'
  | 'load_resume_queue'
  | 'parse_intake'
  | 'ask_switch_or_merge'
  | 'clarify_low_confidence'
  | 'bd_upsert_epic_and_tasks'
  | 'build_plan_baseline'
  | 'request_plan_review'
  | 'apply_non_blocking_feedback'
  | 'define_observation_targets'
  | 'dispatch_research_agents'
  | 'wait_for_research_results'
  | 'ingest_research_artifacts'
  | 'evaluate_research_sufficiency'
  | 'build_detail_design'
  | 'prepare_coder_handoff'
  | 'schedule_resources'
  | 'enqueue_waiting_task'
  | 'dispatch_coder'
  | 'await_coder_output'
  | 'run_reviewer_executor_mode'
  | 'reject_claim_without_evidence'
  | 'apply_replan_patch'
  | 'finalize_delivery'
  | 'mark_cancelled'
  | 'mark_failed';

export interface OrchestratorV2Command {
  type: OrchestratorV2CommandType;
  payload?: Record<string, unknown>;
}

export type OrchestratorV2Event =
  | { type: 'boot' }
  | { type: 'bd_probe_result'; resumable: ResumeCandidate[] }
  | { type: 'resume_decision'; decision: ResumeDecision }
  | { type: 'resume_plan_loaded' }
  | { type: 'user_input'; text: string }
  | { type: 'intake_completed'; intent: IntakeIntent; conflict: boolean; confidence: number; epicId?: string }
  | { type: 'switch_resolved'; decision: SwitchDecision; confidence?: number; epicId?: string }
  | { type: 'epic_synced'; epicId: string }
  | { type: 'plan_baselined'; confidence: number; needPlanReview?: boolean }
  | { type: 'plan_review_feedback'; blocking?: boolean }
  | { type: 'plan_review_pass' }
  | { type: 'observe_defined'; researchExpected?: number }
  | { type: 'research_dispatched' }
  | { type: 'research_result'; artifact: ResearchArtifactRef }
  | { type: 'research_ingested' }
  | { type: 'research_evaluated'; decision: ResearchDecision; missingSlots?: number }
  | { type: 'detail_designed' }
  | { type: 'coder_handoff_ready' }
  | { type: 'schedule_decided'; resourceBusy: boolean; confidence: number }
  | { type: 'resource_available' }
  | { type: 'dispatch_result'; ok: boolean }
  | { type: 'coder_result'; claimCount: number; evidenceCount: number }
  | { type: 'review_result'; decision: ReviewDecision; claimsWithoutEvidence?: number }
  | { type: 'replan_applied'; confidence: number }
  | { type: 'requirement_changed' }
  | { type: 'cancel' }
  | { type: 'fatal_error'; error: string };

export interface OrchestratorV2TransitionResult extends OrchestratorV2Snapshot {
  changed: boolean;
  commands: OrchestratorV2Command[];
  reason?: string;
}

const TERMINAL_STATES: ReadonlySet<OrchestratorV2State> = new Set(['complete', 'cancelled', 'failed']);
const LOW_CONFIDENCE_THRESHOLD = 0.6;

function isLowConfidence(value: number): boolean {
  return value < LOW_CONFIDENCE_THRESHOLD;
}

function toTimestamp(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function isExecutable(candidate: ResumeCandidate): boolean {
  return !candidate.blockedBy || candidate.blockedBy.length === 0;
}

export function sortResumeCandidates(items: ResumeCandidate[]): ResumeCandidate[] {
  return [...items].sort((a, b) => {
    const executableDelta = Number(isExecutable(b)) - Number(isExecutable(a));
    if (executableDelta !== 0) {
      return executableDelta;
    }
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    const updatedAtDelta = toTimestamp(b.updatedAt) - toTimestamp(a.updatedAt);
    if (updatedAtDelta !== 0) {
      return updatedAtDelta;
    }
    return a.epicId.localeCompare(b.epicId);
  });
}

export function createDefaultOrchestratorV2Context(
  override: Partial<OrchestratorV2Context> = {}
): OrchestratorV2Context {
  return {
    autoResume: false,
    confidence: 1,
    currentEpicId: undefined,
    pendingEpicId: undefined,
    resumeCandidates: [],
    resumeQueue: [],
    reviewerFeedbackCount: 0,
    maxReviewerFeedbackCount: 3,
    researchExpected: 0,
    researchReceived: 0,
    researchArtifacts: [],
    lastError: undefined,
    ...override,
  };
}

function withTransition(
  snapshot: OrchestratorV2Snapshot,
  nextState: OrchestratorV2State,
  contextPatch: Partial<OrchestratorV2Context> = {},
  commands: OrchestratorV2Command[] = [],
  reason?: string
): OrchestratorV2TransitionResult {
  return {
    state: nextState,
    context: {
      ...snapshot.context,
      ...contextPatch,
    },
    changed: snapshot.state !== nextState || Object.keys(contextPatch).length > 0 || commands.length > 0,
    commands,
    reason,
  };
}

function withNoop(snapshot: OrchestratorV2Snapshot, reason: string): OrchestratorV2TransitionResult {
  return {
    state: snapshot.state,
    context: snapshot.context,
    changed: false,
    commands: [],
    reason,
  };
}

function applyGlobalTransitions(
  snapshot: OrchestratorV2Snapshot,
  event: OrchestratorV2Event
): OrchestratorV2TransitionResult | null {
  if (TERMINAL_STATES.has(snapshot.state)) {
    return withNoop(snapshot, 'terminal_state_ignored');
  }

  if (event.type === 'cancel') {
    return withTransition(
      snapshot,
      'cancelled',
      {},
      [{ type: 'mark_cancelled' }],
      'cancelled_by_user'
    );
  }

  if (event.type === 'fatal_error') {
    return withTransition(
      snapshot,
      'failed',
      { lastError: event.error },
      [{ type: 'mark_failed', payload: { error: event.error } }],
      'fatal_error'
    );
  }

  if (event.type === 'requirement_changed' && snapshot.state !== 'replan_patch') {
    return withTransition(
      snapshot,
      'replan_patch',
      {},
      [{ type: 'apply_replan_patch' }],
      'requirement_changed'
    );
  }

  return null;
}

export function transitionOrchestratorV2(
  snapshot: OrchestratorV2Snapshot,
  event: OrchestratorV2Event
): OrchestratorV2TransitionResult {
  const global = applyGlobalTransitions(snapshot, event);
  if (global) {
    return global;
  }

  switch (snapshot.state) {
    case 'boot': {
      if (event.type !== 'boot') {
        return withNoop(snapshot, 'invalid_event_for_boot');
      }
      return withTransition(
        snapshot,
        'idle_probe_bd',
        {},
        [{ type: 'probe_bd_resumable' }],
        'boot_started'
      );
    }

    case 'idle_probe_bd': {
      if (event.type !== 'bd_probe_result') {
        return withNoop(snapshot, 'invalid_event_for_idle_probe_bd');
      }
      const sorted = sortResumeCandidates(event.resumable);
      if (sorted.length === 0) {
        return withTransition(snapshot, 'idle', { resumeCandidates: [], resumeQueue: [] }, [], 'no_resumable_items');
      }
      if (snapshot.context.autoResume) {
        return withTransition(
          snapshot,
          'resume_plan',
          { resumeCandidates: sorted, resumeQueue: sorted },
          [{ type: 'load_resume_queue' }],
          'auto_resume_enabled'
        );
      }
      return withTransition(
        snapshot,
        'resume_ask',
        { resumeCandidates: sorted, resumeQueue: sorted },
        [{ type: 'ask_resume', payload: { candidates: sorted } }],
        'found_resumable_items'
      );
    }

    case 'resume_ask': {
      if (event.type !== 'resume_decision') {
        return withNoop(snapshot, 'invalid_event_for_resume_ask');
      }
      if (event.decision === 'yes') {
        return withTransition(
          snapshot,
          'resume_plan',
          {},
          [{ type: 'load_resume_queue' }],
          'resume_confirmed'
        );
      }
      return withTransition(snapshot, 'idle', { resumeQueue: [] }, [], 'resume_declined');
    }

    case 'resume_plan': {
      if (event.type !== 'resume_plan_loaded') {
        return withNoop(snapshot, 'invalid_event_for_resume_plan');
      }
      return withTransition(
        snapshot,
        'observe',
        {},
        [{ type: 'define_observation_targets', payload: { source: 'resume_queue' } }],
        'resume_queue_loaded'
      );
    }

    case 'idle': {
      if (event.type !== 'user_input') {
        return withNoop(snapshot, 'invalid_event_for_idle');
      }
      return withTransition(
        snapshot,
        'intake',
        {},
        [{ type: 'parse_intake', payload: { text: event.text } }],
        'user_input_received'
      );
    }

    case 'intake': {
      if (event.type !== 'intake_completed') {
        return withNoop(snapshot, 'invalid_event_for_intake');
      }
      const contextPatch: Partial<OrchestratorV2Context> = {
        confidence: event.confidence,
        pendingEpicId: event.epicId,
      };
      if (isLowConfidence(event.confidence)) {
        return withTransition(
          snapshot,
          'ask_switch',
          contextPatch,
          [{ type: 'clarify_low_confidence' }],
          'confidence_lt_0_6'
        );
      }
      if (event.conflict) {
        return withTransition(
          snapshot,
          'ask_switch',
          contextPatch,
          [{ type: 'ask_switch_or_merge' }],
          'conflict_with_current_epic'
        );
      }
      return withTransition(
        snapshot,
        'epic_sync',
        contextPatch,
        [{ type: 'bd_upsert_epic_and_tasks' }],
        'intake_ok'
      );
    }

    case 'ask_switch': {
      if (event.type !== 'switch_resolved') {
        return withNoop(snapshot, 'invalid_event_for_ask_switch');
      }
      const nextConfidence = event.confidence ?? snapshot.context.confidence;
      if (isLowConfidence(nextConfidence)) {
        return withTransition(
          snapshot,
          'ask_switch',
          { confidence: nextConfidence },
          [{ type: 'clarify_low_confidence' }],
          'still_low_confidence'
        );
      }
      return withTransition(
        snapshot,
        'epic_sync',
        {
          confidence: nextConfidence,
          pendingEpicId: event.epicId ?? snapshot.context.pendingEpicId,
        },
        [{ type: 'bd_upsert_epic_and_tasks' }],
        'switch_resolved'
      );
    }

    case 'epic_sync': {
      if (event.type !== 'epic_synced') {
        return withNoop(snapshot, 'invalid_event_for_epic_sync');
      }
      return withTransition(
        snapshot,
        'plan_baseline',
        {
          currentEpicId: event.epicId,
          pendingEpicId: undefined,
          reviewerFeedbackCount: 0,
        },
        [{ type: 'build_plan_baseline' }],
        'epic_synced'
      );
    }

    case 'plan_baseline': {
      if (event.type !== 'plan_baselined') {
        return withNoop(snapshot, 'invalid_event_for_plan_baseline');
      }
      if (isLowConfidence(event.confidence)) {
        return withTransition(
          snapshot,
          'ask_switch',
          { confidence: event.confidence },
          [{ type: 'clarify_low_confidence' }],
          'plan_confidence_lt_0_6'
        );
      }
      if (event.needPlanReview) {
        return withTransition(
          snapshot,
          'plan_review',
          {
            confidence: event.confidence,
            reviewerFeedbackCount: 0,
          },
          [{ type: 'request_plan_review' }],
          'need_plan_review'
        );
      }
      return withTransition(
        snapshot,
        'observe',
        { confidence: event.confidence },
        [{ type: 'define_observation_targets' }],
        'skip_plan_review'
      );
    }

    case 'plan_review': {
      if (event.type === 'plan_review_pass') {
        return withTransition(
          snapshot,
          'observe',
          { reviewerFeedbackCount: 0 },
          [{ type: 'define_observation_targets' }],
          'plan_review_pass'
        );
      }
      if (event.type !== 'plan_review_feedback') {
        return withNoop(snapshot, 'invalid_event_for_plan_review');
      }
      if (event.blocking) {
        return withTransition(
          snapshot,
          'plan_baseline',
          { reviewerFeedbackCount: 0 },
          [{ type: 'build_plan_baseline' }],
          'blocking_feedback_replan'
        );
      }
      const nextCount = snapshot.context.reviewerFeedbackCount + 1;
      if (nextCount >= snapshot.context.maxReviewerFeedbackCount) {
        return withTransition(
          snapshot,
          'observe',
          { reviewerFeedbackCount: 0 },
          [{ type: 'define_observation_targets' }],
          'feedback_limit_reached'
        );
      }
      return withTransition(
        snapshot,
        'plan_review',
        { reviewerFeedbackCount: nextCount },
        [{ type: 'apply_non_blocking_feedback' }],
        'non_blocking_feedback'
      );
    }

    case 'observe': {
      if (event.type !== 'observe_defined') {
        return withNoop(snapshot, 'invalid_event_for_observe');
      }
      const expected = Math.max(1, event.researchExpected ?? 1);
      return withTransition(
        snapshot,
        'research_fanout',
        {
          researchExpected: expected,
          researchReceived: 0,
          researchArtifacts: [],
        },
        [{ type: 'dispatch_research_agents', payload: { slots: expected } }],
        'observe_targets_defined'
      );
    }

    case 'research_fanout': {
      if (event.type === 'research_dispatched') {
        return withTransition(
          snapshot,
          'wait_others',
          {},
          [{ type: 'wait_for_research_results' }],
          'waiting_for_research_results'
        );
      }
      if (event.type !== 'research_result') {
        return withNoop(snapshot, 'invalid_event_for_research_fanout');
      }
      return withTransition(
        snapshot,
        'research_ingest',
        {
          researchReceived: snapshot.context.researchReceived + 1,
          researchArtifacts: [...snapshot.context.researchArtifacts, event.artifact],
        },
        [{ type: 'ingest_research_artifacts', payload: { artifact: event.artifact } }],
        'research_result_arrived'
      );
    }

    case 'wait_others': {
      if (event.type !== 'research_result') {
        return withNoop(snapshot, 'invalid_event_for_wait_others');
      }
      return withTransition(
        snapshot,
        'research_ingest',
        {
          researchReceived: snapshot.context.researchReceived + 1,
          researchArtifacts: [...snapshot.context.researchArtifacts, event.artifact],
        },
        [{ type: 'ingest_research_artifacts', payload: { artifact: event.artifact } }],
        'research_result_arrived'
      );
    }

    case 'research_ingest': {
      if (event.type !== 'research_ingested') {
        return withNoop(snapshot, 'invalid_event_for_research_ingest');
      }
      return withTransition(
        snapshot,
        'research_eval',
        {},
        [{ type: 'evaluate_research_sufficiency' }],
        'research_ingested'
      );
    }

    case 'research_eval': {
      if (event.type !== 'research_evaluated') {
        return withNoop(snapshot, 'invalid_event_for_research_eval');
      }
      if (event.decision === 'need_replan') {
        return withTransition(
          snapshot,
          'plan_baseline',
          {},
          [{ type: 'build_plan_baseline' }],
          'research_need_replan'
        );
      }
      if (event.decision === 'need_more_results') {
        const missingSlots = Math.max(0, event.missingSlots ?? 0);
        if (missingSlots > 0) {
          return withTransition(
            snapshot,
            'research_fanout',
            {},
            [{ type: 'dispatch_research_agents', payload: { slots: missingSlots } }],
            'research_need_more_fanout'
          );
        }
        return withTransition(
          snapshot,
          'wait_others',
          {},
          [{ type: 'wait_for_research_results' }],
          'research_wait_others'
        );
      }
      return withTransition(
        snapshot,
        'detail_design',
        {},
        [{ type: 'build_detail_design' }],
        'research_enough_info'
      );
    }

    case 'detail_design': {
      if (event.type !== 'detail_designed') {
        return withNoop(snapshot, 'invalid_event_for_detail_design');
      }
      return withTransition(
        snapshot,
        'coder_handoff',
        {},
        [{ type: 'prepare_coder_handoff' }],
        'detail_design_ready'
      );
    }

    case 'coder_handoff': {
      if (event.type !== 'coder_handoff_ready') {
        return withNoop(snapshot, 'invalid_event_for_coder_handoff');
      }
      return withTransition(
        snapshot,
        'schedule',
        {},
        [{ type: 'schedule_resources' }],
        'coder_handoff_ready'
      );
    }

    case 'schedule': {
      if (event.type !== 'schedule_decided') {
        return withNoop(snapshot, 'invalid_event_for_schedule');
      }
      if (isLowConfidence(event.confidence)) {
        return withTransition(
          snapshot,
          'ask_switch',
          { confidence: event.confidence },
          [{ type: 'clarify_low_confidence' }],
          'schedule_confidence_lt_0_6'
        );
      }
      if (event.resourceBusy) {
        return withTransition(
          snapshot,
          'queue',
          { confidence: event.confidence },
          [{ type: 'enqueue_waiting_task' }],
          'resource_busy'
        );
      }
      return withTransition(
        snapshot,
        'dispatch',
        { confidence: event.confidence },
        [{ type: 'dispatch_coder' }],
        'resource_ready'
      );
    }

    case 'queue': {
      if (event.type !== 'resource_available') {
        return withNoop(snapshot, 'invalid_event_for_queue');
      }
      return withTransition(
        snapshot,
        'dispatch',
        {},
        [{ type: 'dispatch_coder' }],
        'resource_available'
      );
    }

    case 'dispatch': {
      if (event.type !== 'dispatch_result') {
        return withNoop(snapshot, 'invalid_event_for_dispatch');
      }
      if (!event.ok) {
        return withTransition(
          snapshot,
          'replan_patch',
          {},
          [{ type: 'apply_replan_patch' }],
          'dispatch_failed'
        );
      }
      return withTransition(
        snapshot,
        'coder_exec',
        {},
        [{ type: 'await_coder_output' }],
        'dispatch_success'
      );
    }

    case 'coder_exec': {
      if (event.type !== 'coder_result') {
        return withNoop(snapshot, 'invalid_event_for_coder_exec');
      }
      return withTransition(
        snapshot,
        'review_accept',
        {},
        [{
          type: 'run_reviewer_executor_mode',
          payload: {
            claimCount: event.claimCount,
            evidenceCount: event.evidenceCount,
          },
        }],
        'coder_result_arrived'
      );
    }

    case 'review_accept': {
      if (event.type !== 'review_result') {
        return withNoop(snapshot, 'invalid_event_for_review_accept');
      }
      const claimsWithoutEvidence = Math.max(0, event.claimsWithoutEvidence ?? 0);
      if (claimsWithoutEvidence > 0) {
        return withTransition(
          snapshot,
          'coder_handoff',
          {},
          [{
            type: 'reject_claim_without_evidence',
            payload: { claimsWithoutEvidence },
          }],
          'claim_without_evidence'
        );
      }
      if (event.decision === 'retry') {
        return withTransition(
          snapshot,
          'coder_handoff',
          {},
          [{ type: 'prepare_coder_handoff' }],
          'review_retry'
        );
      }
      if (event.decision === 'replan') {
        return withTransition(
          snapshot,
          'replan_patch',
          {},
          [{ type: 'apply_replan_patch' }],
          'review_replan'
        );
      }
      return withTransition(
        snapshot,
        'complete',
        {},
        [{ type: 'finalize_delivery' }],
        'review_passed'
      );
    }

    case 'replan_patch': {
      if (event.type !== 'replan_applied') {
        return withNoop(snapshot, 'invalid_event_for_replan_patch');
      }
      if (isLowConfidence(event.confidence)) {
        return withTransition(
          snapshot,
          'ask_switch',
          { confidence: event.confidence },
          [{ type: 'clarify_low_confidence' }],
          'replan_confidence_lt_0_6'
        );
      }
      return withTransition(
        snapshot,
        'plan_baseline',
        { confidence: event.confidence },
        [{ type: 'build_plan_baseline' }],
        'replan_applied'
      );
    }

    case 'complete':
    case 'cancelled':
    case 'failed':
      return withNoop(snapshot, 'terminal_state');

    default:
      return withNoop(snapshot, 'unknown_state');
  }
}

export class OrchestratorFSMV2 {
  private snapshot: OrchestratorV2Snapshot;

  constructor(initial?: Partial<OrchestratorV2Snapshot>) {
    this.snapshot = {
      state: initial?.state ?? 'boot',
      context: createDefaultOrchestratorV2Context(initial?.context),
    };
  }

  getSnapshot(): OrchestratorV2Snapshot {
    return this.snapshot;
  }

  dispatch(event: OrchestratorV2Event): OrchestratorV2TransitionResult {
    const next = transitionOrchestratorV2(this.snapshot, event);
    this.snapshot = {
      state: next.state,
      context: next.context,
    };
    return next;
  }
}
