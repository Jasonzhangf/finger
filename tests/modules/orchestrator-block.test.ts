import { describe, it, expect } from 'vitest';
import { OrchestratorBlock } from '../../src/blocks/orchestrator-block/index.js';

describe('OrchestratorBlock', () => {
  it('starts, pauses, resumes, and reports status', async () => {
    const block = new OrchestratorBlock('orch-test');
    const started = await block.execute('start', {});
    expect(started).toEqual({ started: true });

    const status1 = await block.execute('status', {});
    expect(status1).toMatchObject({ running: true });

    const paused = await block.execute('pause', {});
    expect(paused).toEqual({ paused: true });

    const resumed = await block.execute('resume', {});
    expect(resumed).toEqual({ resumed: true });
  });

  it('decomposes and schedules', async () => {
    const block = new OrchestratorBlock('orch-test');
    await block.execute('start', {});
    const decomposed = await block.execute('decompose', { projectId: 'p1', task: 'T' });
    expect(decomposed).toEqual({ projectId: 'p1', decomposed: true });

    const scheduled = await block.execute('schedule', { projectId: 'p1' });
    expect(scheduled).toEqual({ scheduled: true });
  });
});
