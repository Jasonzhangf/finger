/**
 * OpenClaw Plugin Manager Types
 * Compatible with OpenClaw plugin ecosystem
 */

export type PluginKind = 'channel' | 'skill' | 'provider' | 'memory' | 'context-engine';

export type PluginConfigValidation =
  | { ok: true; value?: unknown }
  | { ok: false; errors: string[] };

export type PluginConfigUiHint = {
  label?: string;
  help?: string;
  tags?: string[];
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
};

/**
 * OpenClaw plugin manifest (openclaw.plugin.json)
 */
export interface OpenClawPluginManifest {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  kind?: PluginKind;
  channels?: string[];
  providers?: string[];
  skills?: string[];
  configSchema?: Record<string, unknown>;
  uiHints?: Record<string, PluginConfigUiHint>;
  capabilities?: Record<string, boolean>;
}

/**
 * Package.json openclaw extension field
 */
export interface PackageJsonOpenClawExtension {
  id: string;
  extensions: string[];
}

/**
 * Plugin installation source
 */
export type PluginSource =
  | { type: 'npm'; spec: string; integrity?: string }
  | { type: 'local'; path: string }
  | { type: 'git'; url: string; ref?: string };

/**
 * Plugin installation result
 */
export type InstallPluginResult =
  | {
      ok: true;
      pluginId: string;
      targetDir: string;
      version?: string;
      manifest: OpenClawPluginManifest;
    }
  | { ok: false; error: string; code?: string };

/**
 * Plugin load result
 */
export type LoadPluginResult =
  | {
      ok: true;
      pluginId: string;
      module: unknown;
      manifest: OpenClawPluginManifest;
    }
  | { ok: false; error: string };

/**
 * Plugin record in registry
 */
export interface PluginRecord {
  id: string;
  manifest: OpenClawPluginManifest;
  installDir: string;
  enabled: boolean;
  config?: Record<string, unknown>;
  module?: unknown;
  sourceKind?: 'finger' | 'openclaw';
}

/**
 * Plugin runtime API - provided to plugin modules
 */
export interface PluginRuntimeApi {
  registerChannel: (channelIdOrRegistration: string | unknown, handler?: unknown) => void;
  registerTool: (tool: unknown) => void;
  registerHook: (hook: unknown) => void;
  registerService: (service: unknown) => void;
  registerGatewayMethod?: (method: string, handler: unknown) => void;
  logger: PluginLogger;
  config?: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  // OpenClaw-compatible runtime with channel routing/reply
  runtime?: {
    config?: Record<string, unknown>;
    channel?: {
      activity: {
        record: (event: { channel: string; accountId: string; direction: string }) => void;
      };
      routing: {
        resolveAgentRoute: (params: { cfg: unknown; channel: string; accountId: string; peer: { kind: string; id: string } }) => { agentId: string };
      };
      reply: {
        resolveEnvelopeFormatOptions: (cfg: unknown) => unknown;
        formatInboundEnvelope: (params: unknown) => unknown;
        finalizeInboundContext: (params: unknown) => unknown;
        resolveEffectiveMessagesConfig: (cfg: unknown, agentId: string) => unknown;
        dispatchReplyWithBufferedBlockDispatcher: (params: { ctx: Record<string, unknown>; cfg: unknown; dispatcherOptions?: unknown }) => Promise<void>;
      };
    };
  };
}

export type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

/**
 * Plugin definition exported by plugin module
 */
export interface OpenClawPluginDefinition {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  register?: (api: PluginRuntimeApi) => void | Promise<void>;
  tools?: unknown[];
  hooks?: unknown[];
  channels?: unknown[];
}
