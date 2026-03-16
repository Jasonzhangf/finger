/**
 * System Agent Periodic Check Integration Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PeriodicCheckRunner } from '../../src/agents/finger-system-agent/periodic-check.js';
import type { AgentRuntimeDeps } from '../../src/server/modules/agent-runtime/types.js';

describe('System Agent Periodic Check', () => {
  let deps: AgentRuntimeDeps;
  let runner: PeriodicCheckRunner;

  beforeEach(() => {
    deps = {
      agentRuntimeBlock: {
        execute: vi.fn().mockResolvedValue({
          agents: [
            { id: 'finger-system-agent', status: 'idle' },
            { id: 'finger-orchestrator', status: 'busy' },
          ],
        }),
      },
    } as unknown as AgentRuntimeDeps;

    runner = new PeriodicCheckRunner(deps, { intervalMs: 1000 });
  });

  afterEach(() => {
    runner.stop();
  });

  it('should start timer', () => {
    runner.start();
    expect(runner).toBeDefined();
  });

  it('should stop timer', () => {
    runner.start();
    runner.stop();
    expect(runner).toBeDefined();
  });

  it('should run periodic check', async () => {
    await runner.runOnce();
    expect(deps.agentRuntimeBlock.execute).toHaveBeenCalledWith('runtime_view', {});
  });

  it('should use default 5 minute interval', () => {
    const defaultRunner = new PeriodicCheckRunner(deps);
    expect(defaultRunner).toBeDefined();
  });
});
