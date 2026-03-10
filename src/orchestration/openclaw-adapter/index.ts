import type { ToolDefinition, ToolRegistry } from '../../runtime/tool-registry.js';
import { OpenClawGateError, type OpenClawGateBlock, type OpenClawTool } from '../../blocks/openclaw-gate/index.js';
import type { Message } from '../../core/schema.js';

export interface OpenClawInvocationInput {
  pluginId: string;
  toolId: string;
  input: Record<string, unknown>;
}

export interface OpenClawInvocationResult {
  ok: boolean;
  pluginId: string;
  toolId: string;
  output?: unknown;
  error?: string;
}

export function toOpenClawToolDefinition(
  pluginId: string,
  tool: OpenClawTool,
  gateBlock: OpenClawGateBlock,
): ToolDefinition {
  return {
    name: `openclaw.${pluginId}.${tool.id}`,
    description: tool.description,
    inputSchema: tool.inputSchema,
    policy: 'allow',
    handler: async (input: unknown) => {
      const normalized = isRecord(input) ? input : {};
      return gateBlock.callTool(pluginId, tool.id, normalized);
    },
  };
}

export function registerOpenClawTools(
  toolRegistry: ToolRegistry,
  gateBlock: OpenClawGateBlock,
): number {
  let count = 0;
  for (const plugin of gateBlock.listPlugins()) {
    if (plugin.status !== 'enabled') continue;
    for (const tool of plugin.tools) {
      toolRegistry.register(toOpenClawToolDefinition(plugin.id, tool, gateBlock));
      count += 1;
    }
  }
  return count;
}

export function mapOpenClawMessageToInvocation(message: Message): OpenClawInvocationInput | null {
  if (message.type !== 'openclaw-call') return null;
  const payload = isRecord(message.payload) ? message.payload : null;
  if (!payload) return null;
  const pluginId = typeof payload.pluginId === 'string' ? payload.pluginId : '';
  const toolId = typeof payload.toolId === 'string' ? payload.toolId : '';
  const input = isRecord(payload.input) ? payload.input : {};
  if (!pluginId || !toolId) return null;
  return { pluginId, toolId, input };
}

export async function invokeOpenClawFromMessage(
  message: Message,
  gateBlock: OpenClawGateBlock,
): Promise<OpenClawInvocationResult | null> {
  const invocation = mapOpenClawMessageToInvocation(message);
  if (!invocation) return null;
  try {
    const output = gateBlock.callTool(invocation.pluginId, invocation.toolId, invocation.input);
    return {
      ok: true,
      pluginId: invocation.pluginId,
      toolId: invocation.toolId,
      output,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = error instanceof OpenClawGateError ? error.code : 'OPENCLAW_INVOCATION_ERROR';
    return {
      ok: false,
      pluginId: invocation.pluginId,
      toolId: invocation.toolId,
      error: `${errorCode}: ${errorMessage}`,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
