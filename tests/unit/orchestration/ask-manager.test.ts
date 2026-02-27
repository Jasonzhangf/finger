import { describe, expect, it } from 'vitest';
import { AskManager } from '../../../src/orchestration/ask/ask-manager.js';

describe('AskManager', () => {
  it('resolves blocking ask by request id', async () => {
    const manager = new AskManager(1_000);
    const { pending, result } = manager.open({
      question: 'Choose one',
      options: ['A', 'B'],
      sessionId: 'session-1',
    });

    expect(manager.listPending({ sessionId: 'session-1' })).toHaveLength(1);
    const resolution = manager.resolveByRequestId(pending.requestId, '2');
    expect(resolution?.ok).toBe(true);
    expect(resolution?.selectedOption).toBe('B');

    const awaited = await result;
    expect(awaited.requestId).toBe(pending.requestId);
    expect(awaited.answer).toBe('2');
    expect(awaited.selectedOption).toBe('B');
    expect(manager.listPending()).toHaveLength(0);
  });

  it('resolves oldest ask by workflow scope', async () => {
    const manager = new AskManager(2_000);
    const first = manager.open({
      question: 'First',
      workflowId: 'wf-1',
    });
    manager.open({
      question: 'Second',
      workflowId: 'wf-1',
    });

    const resolution = manager.resolveOldestByScope({ workflowId: 'wf-1' }, 'yes');
    expect(resolution?.requestId).toBe(first.pending.requestId);
    expect(resolution?.answer).toBe('yes');
    await first.result;
  });

  it('keeps ask resolution isolated by agent scope', async () => {
    const manager = new AskManager(2_000);
    const a1 = manager.open({
      question: 'A1',
      workflowId: 'wf-1',
      agentId: 'orchestrator-a',
    });
    manager.open({
      question: 'A2',
      workflowId: 'wf-1',
      agentId: 'orchestrator-b',
    });

    const resolution = manager.resolveOldestByScope({
      workflowId: 'wf-1',
      agentId: 'orchestrator-b',
    }, 'ok');
    expect(resolution?.requestId).not.toBe(a1.pending.requestId);
  });

  it('times out unanswered asks', async () => {
    const manager = new AskManager(30);
    const { result } = manager.open({
      question: 'Will timeout',
      timeoutMs: 30,
    });

    const resolution = await result;
    expect(resolution.ok).toBe(false);
    expect(resolution.timedOut).toBe(true);
  });
});
