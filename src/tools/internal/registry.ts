import { InternalTool, InternalToolInfo, ToolExecutionContext, createToolExecutionContext } from './types.js';

export class InternalToolRegistry {
  private readonly tools = new Map<string, InternalTool>();

  register(tool: InternalTool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): InternalTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): InternalToolInfo[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async execute(name: string, input: unknown, context: Partial<ToolExecutionContext> = {}): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Internal tool not found: ${name}`);
    }

    const executionContext = createToolExecutionContext(context);
    return tool.execute(input, executionContext);
  }
}
