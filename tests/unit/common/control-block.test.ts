import { describe, expect, it } from 'vitest';
import {
  evaluateControlHooks,
  normalizeControlBlock,
  parseControlBlockFromReply,
  resolveControlBlockPolicy,
} from '../../../src/common/control-block.js';

describe('control-block', () => {
  it('parses valid finger-control fence and strips it from human response', () => {
    const raw = [
      'Done. Here is summary.',
      '',
      '```finger-control',
      JSON.stringify({
        schema_version: '1.1',
        task_completed: true,
        evidence_ready: true,
        needs_user_input: false,
        has_blocker: false,
        dispatch_required: false,
        review_required: false,
        wait: { enabled: false, seconds: 0, reason: '' },
        user_signal: { negative_score: 0, profile_update_required: false, why: '' },
        tags: ['debug', 'fix'],
        self_eval: { score: 88, confidence: 90, goal_gap: '', why: 'ok' },
        anti_patterns: [],
        learning: {
          did_right: ['kept evidence'],
          did_wrong: [],
          repeated_wrong: [],
          flow_patch: { required: false, project_scope: '', changes: [] },
          memory_patch: { required: false, project_scope: '', long_term_items: [], short_term_items: [] },
          user_profile_patch: { required: false, items: [], sensitivity: 'normal' },
        },
      }, null, 2),
      '```',
    ].join('\n');

    const parsed = parseControlBlockFromReply(raw);
    expect(parsed.present).toBe(true);
    expect(parsed.valid).toBe(true);
    expect(parsed.humanResponse).toBe('Done. Here is summary.');
    expect(parsed.controlBlock?.tags).toEqual(['debug', 'fix']);
  });

  it('returns explicit missing marker when fence is absent', () => {
    const parsed = parseControlBlockFromReply('plain answer only');
    expect(parsed.present).toBe(false);
    expect(parsed.valid).toBe(false);
    expect(parsed.issues).toContain('control_block_missing');
  });

  it('normalizes fields and preserves unknown extension keys', () => {
    const normalized = normalizeControlBlock({
      schema_version: '1.2',
      task_completed: 'true',
      evidence_ready: 'false',
      needs_user_input: false,
      has_blocker: false,
      dispatch_required: false,
      review_required: false,
      wait: { enabled: 'true', seconds: '12', reason: 'poll', extension_wait_key: 'x' },
      user_signal: { negative_score: '77', profile_update_required: 'true', why: 'angry', ext: 1 },
      tags: ['a', 'b'],
      self_eval: { score: '-10', confidence: '88', goal_gap: 'missing logs', why: 'bad' },
      anti_patterns: ['do-not'],
      learning: {
        did_right: ['r1'],
        did_wrong: ['w1'],
        repeated_wrong: ['rw1'],
        flow_patch: { required: true, project_scope: 'x', changes: ['c1'] },
        memory_patch: { required: true, project_scope: 'x', long_term_items: ['l1'], short_term_items: ['s1'] },
        user_profile_patch: { required: true, items: ['p1'], sensitivity: 'sensitive' },
      },
      custom_extension_key: 'kept',
    });
    expect(normalized.issues.length).toBe(0);
    expect(normalized.controlBlock.task_completed).toBe(true);
    expect(normalized.controlBlock.evidence_ready).toBe(false);
    expect(normalized.controlBlock.wait.seconds).toBe(12);
    expect(normalized.controlBlock.custom_extension_key).toBe('kept');
  });

  it('evaluates hook map deterministically', () => {
    const { controlBlock } = normalizeControlBlock({
      schema_version: '1.1',
      task_completed: true,
      evidence_ready: false,
      needs_user_input: true,
      has_blocker: false,
      dispatch_required: true,
      review_required: true,
      context_review_hint: 'aggressive',
      wait: { enabled: true, seconds: 30, reason: 'retry' },
      user_signal: { negative_score: 80, profile_update_required: true, why: 'friction' },
      tags: ['x'],
      self_eval: { score: -20, confidence: 40, goal_gap: 'gap', why: 'risk' },
      anti_patterns: ['do-not-repeat'],
      learning: {
        did_right: [],
        did_wrong: ['w'],
        repeated_wrong: ['rw'],
        flow_patch: { required: true, project_scope: 'p', changes: ['f'] },
        memory_patch: { required: true, project_scope: 'p', long_term_items: ['l'], short_term_items: ['s'] },
        user_profile_patch: { required: true, items: ['u'], sensitivity: 'normal' },
      },
    });
    const hooks = evaluateControlHooks(controlBlock);
    expect(hooks.hooks).toContain('hook.task.continue');
    expect(hooks.hooks).toContain('hook.waiting_user');
    expect(hooks.hooks).toContain('hook.scheduler.wait');
    expect(hooks.hooks).toContain('hook.dispatch');
    expect(hooks.hooks).toContain('hook.reviewer');
    expect(hooks.hooks).toContain('hook.context.review');
    expect(hooks.hooks).toContain('hook.digest.negative');
    expect(hooks.hooks).toContain('hook.user.profile.update');
    expect(hooks.hooks).toContain('hook.project.flow.update');
    expect(hooks.holdStop).toBe(true);
  });

  it('resolves policy defaults and metadata overrides', () => {
    const defaults = resolveControlBlockPolicy();
    expect(defaults.enabled).toBe(true);
    expect(defaults.promptInjectionEnabled).toBe(true);
    expect(defaults.requireOnStop).toBe(false);
    expect(defaults.maxAutoContinueTurns).toBe(1);

    const strict = resolveControlBlockPolicy({
      controlBlockEnabled: true,
      controlBlockPromptInjectionEnabled: false,
      controlBlockRequireOnStop: true,
      controlBlockMaxAutoContinueTurns: 3,
    });
    expect(strict.promptInjectionEnabled).toBe(false);
    expect(strict.requireOnStop).toBe(true);
    expect(strict.maxAutoContinueTurns).toBe(3);
  });
});
