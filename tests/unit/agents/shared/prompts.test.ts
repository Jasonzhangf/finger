import { describe, it, expect } from 'vitest';
import {
  buildFinalPrompt,
  buildOrchestratorThinkPrompt,
  buildOrchestratorActPrompt,
  buildExecutorThinkPrompt,
  buildExecutorActPrompt,
  buildReviewerThinkPrompt,
  buildReviewerActPrompt,
  buildTesterThinkPrompt,
  buildTesterActPrompt,
  buildArchitectThinkPrompt,
  buildArchitectActPrompt,
 } from '../../../../src/agents/shared/prompts.js';

describe('shared/prompts', () => {
  it('buildFinalPrompt should format reasoning and actions', () => {
    const prompt = buildFinalPrompt(['r1', 'r2'], ['a1', 'a2']);
    expect(prompt).toContain('Reasoning:');
    expect(prompt).toContain('r1');
    expect(prompt).toContain('a2');
  });
  it('buildOrchestratorThinkPrompt should include task and context', () => {
    const prompt = buildOrchestratorThinkPrompt('task x', { priority: 1 });
    expect(prompt).toContain('Task to orchestrate: task x');
    expect(prompt).toContain('"priority":1');
  });
  it('buildOrchestratorThinkPrompt should handle empty context', () => {
    const prompt = buildOrchestratorThinkPrompt('task x');
    expect(prompt).toContain('Context: {}');
  });
  it('buildOrchestratorActPrompt should include thought', () => {
    const prompt = buildOrchestratorActPrompt('need split');
    expect(prompt).toContain('need split');
    expect(prompt).toContain('subtasks');
  });
  it('buildExecutorThinkPrompt should include task and context', () => {
    const prompt = buildExecutorThinkPrompt('implement A', { file: 'a.ts' });
    expect(prompt).toContain('Execution task: implement A');
    expect(prompt).toContain('"file":"a.ts"');
  });
  it('buildExecutorActPrompt should include thought', () => {
    const prompt = buildExecutorActPrompt('refactor module');
    expect(prompt).toContain('refactor module');
    expect(prompt).toContain('create/modify');
  });
  it('buildReviewerThinkPrompt should include task and context', () => {
    const prompt = buildReviewerThinkPrompt('review PR', { risk: 'high' });
    expect(prompt).toContain('Review task: review PR');
    expect(prompt).toContain('"risk":"high"');
  });
  it('buildReviewerActPrompt should include thought', () => {
    const prompt = buildReviewerActPrompt('check regressions');
    expect(prompt).toContain('check regressions');
    expect(prompt).toContain('Identify issues');
  });
  it('buildTesterThinkPrompt should include task and context', () => {
    const prompt = buildTesterThinkPrompt('add tests', { module: 'runtime' });
    expect(prompt).toContain('Testing task: add tests');
    expect(prompt).toContain('"module":"runtime"');
  });
  it('buildTesterActPrompt should include thought', () => {
    const prompt = buildTesterActPrompt('cover edge cases');
    expect(prompt).toContain('cover edge cases');
    expect(prompt).toContain('test cases');
  });
  it('buildArchitectThinkPrompt should include task and context', () => {
    const prompt = buildArchitectThinkPrompt('design event model', { scale: 'large' });
    expect(prompt).toContain('Architecture task: design event model');
    expect(prompt).toContain('"scale":"large"');
  });
  it('buildArchitectActPrompt should include thought', () => {
    const prompt = buildArchitectActPrompt('choose message schema');
    expect(prompt).toContain('choose message schema');
    expect(prompt).toContain('architectural decisions');
  });
});
