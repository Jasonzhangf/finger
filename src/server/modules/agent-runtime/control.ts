import type { AgentControlRequest, AgentControlResult, AgentRuntimeDeps } from './types.js';

export async function controlAgentRuntime(
  deps: AgentRuntimeDeps,
  input: AgentControlRequest,
): Promise<AgentControlResult> {
  const result = await deps.agentRuntimeBlock.execute('control', input as unknown as Record<string, unknown>);
  return result as AgentControlResult;
}
