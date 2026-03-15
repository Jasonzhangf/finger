/**
 * System Agent Manager
 *
 * 在 daemon 中启动 System Agent 的定时检查任务
 */

import type { AgentRuntimeDeps } from './agent-runtime/types.js';
import { PeriodicCheckRunner } from '../../agents/finger-system-agent/periodic-check.js';

export class SystemAgentManager {
  private runner: PeriodicCheckRunner | null = null;

  constructor(private deps: AgentRuntimeDeps) {}

  start(): void {
    if (this.runner) return;
    this.runner = new PeriodicCheckRunner(this.deps);
    this.runner.start();
  }

  stop(): void {
    if (!this.runner) return;
    this.runner.stop();
    this.runner = null;
  }
}
