export interface ToolExecutionContext {
  invocationId: string;
  cwd: string;
  timestamp: string;
}

export interface InternalTool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Input, context: ToolExecutionContext) => Promise<Output>;
}

export interface InternalToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function createToolExecutionContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  const now = new Date();
  return {
    invocationId: overrides.invocationId ?? `tool-${now.getTime()}`,
    cwd: overrides.cwd ?? process.cwd(),
    timestamp: overrides.timestamp ?? now.toISOString(),
  };
}
