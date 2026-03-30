import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadWithFingerHome(home: string) {
  vi.resetModules();
  process.env.FINGER_HOME = home;
  const [{ UnifiedEventBus }, { ExecutionUpdateShadowPipeline }] = await Promise.all([
    import('../../../src/runtime/event-bus'),
    import('../../../src/server/modules/execution-update-shadow-pipeline'),
  ]);
  return { UnifiedEventBus, ExecutionUpdateShadowPipeline };
}

describe('ExecutionUpdateShadowPipeline', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    delete process.env.FINGER_HOME;
    for (const dir of tmpDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps same flowId with monotonic seq for dispatch -> tool -> completion', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'finger-shadow-test-'));
    tmpDirs.push(home);
    const { UnifiedEventBus, ExecutionUpdateShadowPipeline } = await loadWithFingerHome(home);
    const eventBus = new UnifiedEventBus();
    const pipeline = new ExecutionUpdateShadowPipeline(eventBus, {
      sessionManager: {
        getSession: () => undefined,
      },
    } as any);

    pipeline.start();
    const ts = new Date().toISOString();
    await eventBus.emit({
      type: 'agent_runtime_dispatch',
      sessionId: 'session-test',
      timestamp: ts,
      payload: {
        dispatchId: 'dispatch-1',
        sourceAgentId: 'finger-system-agent',
        targetAgentId: 'finger-project-agent',
        status: 'queued',
        blocking: false,
        assignment: {
          taskId: 'task-1',
        },
      },
    } as any);
    await eventBus.emit({
      type: 'tool_result',
      sessionId: 'session-test',
      timestamp: ts,
      toolId: 'tool-1',
      toolName: 'exec_command',
      agentId: 'finger-project-agent',
      payload: {
        output: 'ok',
        duration: 20,
      },
    } as any);
    await eventBus.emit({
      type: 'turn_complete',
      sessionId: 'session-test',
      timestamp: ts,
      payload: {
        finishReason: 'stop',
      },
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 120));
    pipeline.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const canonicalDir = path.join(home, 'runtime', 'events', 'canonical');
    const files = (await readdir(canonicalDir)).filter((name) => name.endsWith('.jsonl')).sort();
    expect(files.length).toBeGreaterThan(0);
    const content = await readFile(path.join(canonicalDir, files[files.length - 1]), 'utf-8');
    const events = content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const target = events.slice(-3);

    expect(target).toHaveLength(3);
    expect(target[0].phase).toBe('dispatch');
    expect(target[1].phase).toBe('execution');
    expect(target[2].phase).toBe('completion');
    expect(target.map((item) => item.flowId)).toEqual(['task-1', 'task-1', 'task-1']);
    expect(target.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it('restores session-agent flow binding after restart from correlation log', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'finger-shadow-test-'));
    tmpDirs.push(home);

    {
      const { UnifiedEventBus, ExecutionUpdateShadowPipeline } = await loadWithFingerHome(home);
      const eventBus = new UnifiedEventBus();
      const pipeline = new ExecutionUpdateShadowPipeline(eventBus, {
        sessionManager: {
          getSession: () => undefined,
        },
      } as any);
      pipeline.start();
      const ts = new Date().toISOString();
      await eventBus.emit({
        type: 'agent_runtime_dispatch',
        sessionId: 'session-restart',
        timestamp: ts,
        payload: {
          dispatchId: 'dispatch-r1',
          sourceAgentId: 'finger-system-agent',
          targetAgentId: 'finger-project-agent',
          status: 'queued',
          blocking: false,
          assignment: {
            taskId: 'task-restart-1',
          },
        },
      } as any);
      await new Promise((resolve) => setTimeout(resolve, 80));
      pipeline.stop();
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    {
      const { UnifiedEventBus, ExecutionUpdateShadowPipeline } = await loadWithFingerHome(home);
      const eventBus = new UnifiedEventBus();
      const pipeline = new ExecutionUpdateShadowPipeline(eventBus, {
        sessionManager: {
          getSession: () => undefined,
        },
      } as any);
      pipeline.start();
      const ts = new Date().toISOString();
      await eventBus.emit({
        type: 'tool_result',
        sessionId: 'session-restart',
        timestamp: ts,
        toolId: 'tool-r1',
        toolName: 'exec_command',
        agentId: 'finger-project-agent',
        payload: {
          output: 'ok',
          duration: 10,
        },
      } as any);
      await new Promise((resolve) => setTimeout(resolve, 120));
      pipeline.stop();
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    const canonicalDir = path.join(home, 'runtime', 'events', 'canonical');
    const files = (await readdir(canonicalDir)).filter((name) => name.endsWith('.jsonl')).sort();
    const content = await readFile(path.join(canonicalDir, files[files.length - 1]), 'utf-8');
    const events = content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const relevant = events.filter((event) => event.sessionId === 'session-restart');

    expect(relevant.length).toBeGreaterThanOrEqual(2);
    const dispatchEvent = relevant.find((event) => event.phase === 'dispatch');
    const toolEvent = relevant.find((event) => event.kind === 'tool');
    expect(dispatchEvent?.flowId).toBe('task-restart-1');
    expect(toolEvent?.flowId).toBe('task-restart-1');
    expect(toolEvent?.seq).toBeGreaterThan(1);
  });
});
