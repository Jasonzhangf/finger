import { InternalToolRegistry } from './registry.js';
import { resolveAvailableCliCapabilities } from '../external/cli-capability-registry.js';
import { createCliCapabilityTool } from './cli-capability-tool.js';
import { shellExecTool } from './shell-tool.js';
import { execCommandTool, writeStdinTool } from './codex-exec-tools.js';
import { applyPatchTool } from './codex-apply-patch-tool.js';
import { codexShellTool } from './codex-shell-tool.js';
import { unifiedExecTool } from './codex-unified-exec-tool.js';
import { updatePlanTool } from './codex-update-plan-tool.js';
import { viewImageTool } from './codex-view-image-tool.js';
import { clockTool } from './codex-clock-tool.js';
import { noopTool } from './codex-noop-tool.js';
import { webSearchTool } from './codex-web-search-tool.js';
import { contextLedgerMemoryTool } from './context-ledger-memory-tool.js';

export * from './types.js';
export * from './registry.js';
export * from './shell-tool.js';
export * from './spawn-runner.js';
export * from './cli-capability-tool.js';
export * from './codex-exec-session-manager.js';
export * from './codex-exec-tools.js';
export * from './codex-apply-patch-tool.js';
export * from './codex-shell-tool.js';
export * from './codex-unified-exec-tool.js';
export * from './codex-update-plan-tool.js';
export * from './codex-view-image-tool.js';
export * from './codex-clock-tool.js';
export * from './codex-noop-tool.js';
export * from './codex-web-search-tool.js';
export * from './context-ledger-memory-tool.js';

export function createDefaultInternalToolRegistry(): InternalToolRegistry {
  const registry = new InternalToolRegistry();
  registry.register(shellExecTool);
  registry.register(codexShellTool);
  registry.register(unifiedExecTool);
  registry.register(execCommandTool);
  registry.register(writeStdinTool);
  registry.register(applyPatchTool);
  registry.register(updatePlanTool);
  registry.register(viewImageTool);
  registry.register(clockTool);
  registry.register(noopTool);
  registry.register(webSearchTool);
  registry.register(contextLedgerMemoryTool);
  const capabilities = resolveAvailableCliCapabilities();
  for (const capability of capabilities) {
    registry.register(createCliCapabilityTool(capability));
  }
  return registry;
}
