import type { OpenClawGateBlock, OpenClawTool } from '../openclaw-gate/index.js';
import type { OpenClawPluginDefinition, PluginLogger, PluginRuntimeApi } from './types.js';

export type OpenClawRegisterChannelInput = {
  plugin: {
    id: string;
    meta?: {
      label?: string;
      selectionLabel?: string;
      blurb?: string;
      docsPath?: string;
      docsLabel?: string;
      order?: number;
    };
    capabilities?: Record<string, unknown>;
    configSchema?: {
      schema?: Record<string, unknown>;
    } | Record<string, unknown>;
  };
};

export type OpenClawGatewayMethodHandler = (payload: {
  params?: Record<string, unknown>;
  context?: Record<string, unknown>;
  respond: (ok: boolean, result?: unknown, error?: unknown) => void;
}) => unknown | Promise<unknown>;

export type OpenClawCompatRuntimeApi = PluginRuntimeApi & {
  registerGatewayMethod: (method: string, handler: OpenClawGatewayMethodHandler) => void;
  pluginConfig?: Record<string, unknown>;
};

export function createOpenClawRuntimeApi(params: {
  pluginId: string;
  gate: OpenClawGateBlock;
  logger: PluginLogger;
  pluginConfig?: Record<string, unknown>;
}): OpenClawCompatRuntimeApi {
  const { pluginId, gate, logger, pluginConfig } = params;

  return {
    logger,
    config: pluginConfig,
    pluginConfig,
    registerChannel: (registration: unknown) => {
      const channel = normalizeChannelRegistration(registration);
      if (!channel) {
        logger.warn(`Ignored invalid channel registration for plugin ${pluginId}`);
        return;
      }

      const schema = extractSchema(channel);
      const tool: OpenClawTool = {
        id: `channel.${channel.id}`,
        name: channel.meta?.label || channel.id,
        description: channel.meta?.blurb || `OpenClaw channel ${channel.id}`,
        inputSchema: schema,
        outputSchema: { type: 'object' },
      };
      gate.addTool(pluginId, tool);
      logger.info(`Registered OpenClaw channel ${channel.id} for plugin ${pluginId}`);
    },
    registerGatewayMethod: (method: string, _handler: unknown) => {
      const normalizedMethod = typeof method === 'string' ? method.trim() : '';
      if (!normalizedMethod) {
        logger.warn(`Ignored empty gateway method for plugin ${pluginId}`);
        return;
      }
      const tool: OpenClawTool = {
        id: `gateway.${normalizedMethod.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
        name: normalizedMethod,
        description: `OpenClaw gateway method ${normalizedMethod}`,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      };
      gate.addTool(pluginId, tool);
      logger.info(`Registered OpenClaw gateway method ${normalizedMethod} for plugin ${pluginId}`);
    },
    registerTool: (tool: unknown) => {
      const normalizedTool = normalizeTool(tool);
      if (!normalizedTool) {
        logger.warn(`Ignored invalid tool registration for plugin ${pluginId}`);
        return;
      }
      gate.addTool(pluginId, normalizedTool);
      logger.info(`Registered OpenClaw tool ${normalizedTool.id} for plugin ${pluginId}`);
    },
    registerHook: (_hook: unknown) => {
      logger.info(`Registered OpenClaw hook for plugin ${pluginId}`);
    },
    registerService: (_service: unknown) => {
      logger.info(`Registered OpenClaw service for plugin ${pluginId}`);
    },
  };
}

export function normalizePluginDefinition(moduleValue: unknown): OpenClawPluginDefinition | null {
  if (!moduleValue || typeof moduleValue !== 'object') return null;
  const candidate = moduleValue as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || candidate.id.trim().length === 0) return null;
  return candidate as unknown as OpenClawPluginDefinition;
}

function normalizeChannelRegistration(registration: unknown): OpenClawRegisterChannelInput['plugin'] | null {
  if (!registration || typeof registration !== 'object') return null;
  const record = registration as Record<string, unknown>;
  const plugin = (record.plugin ?? record) as Record<string, unknown>;
  if (!plugin || typeof plugin.id !== 'string' || plugin.id.trim().length === 0) return null;
  return plugin as unknown as OpenClawRegisterChannelInput['plugin'];
}

function extractSchema(channel: OpenClawRegisterChannelInput['plugin']): Record<string, unknown> {
  const configSchema = channel.configSchema;
  if (configSchema && typeof configSchema === 'object') {
    const wrapped = configSchema as Record<string, unknown>;
    const schema = wrapped.schema;
    if (schema && typeof schema === 'object') return schema as Record<string, unknown>;
    return wrapped;
  }
  return { type: 'object' };
}

function normalizeTool(tool: unknown): OpenClawTool | null {
  if (!tool || typeof tool !== 'object') return null;
  const record = tool as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.trim().length === 0) return null;
  return {
    id: record.id,
    name: typeof record.name === 'string' ? record.name : record.id,
    description: typeof record.description === 'string' ? record.description : record.id,
    inputSchema: isRecord(record.inputSchema) ? record.inputSchema : { type: 'object' },
    outputSchema: isRecord(record.outputSchema) ? record.outputSchema : { type: 'object' },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
