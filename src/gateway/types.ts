export type GatewayDirection = 'input' | 'output' | 'bidirectional';
export type GatewayTransport = 'process_stdio';
export type GatewayDeliveryMode = 'sync' | 'async';

export interface GatewayProcessConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  ackTimeoutMs?: number;
  helpArgs?: string[];
  versionArgs?: string[];
}

export interface GatewayModeConfig {
  supported: GatewayDeliveryMode[];
  default: GatewayDeliveryMode;
}

export interface GatewayInputConfig {
  defaultTarget?: string;
}

export interface GatewayDocsConfig {
  readmeFile?: string;
  cliDocFile?: string;
}

export interface GatewayModuleManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  direction: GatewayDirection;
  transport: GatewayTransport;
  mode: GatewayModeConfig;
  process: GatewayProcessConfig;
  input?: GatewayInputConfig;
  docs?: GatewayDocsConfig;
  enabled?: boolean;
}

export interface ResolvedGatewayModule {
  manifest: GatewayModuleManifest;
  modulePath: string;
  moduleDir: string;
  readmePath?: string;
  cliDocPath?: string;
  readmeExcerpt?: string;
  cliDocExcerpt?: string;
}

export interface GatewayRequestEnvelope {
  type: 'request';
  requestId: string;
  deliveryMode: GatewayDeliveryMode;
  message: unknown;
  metadata?: Record<string, unknown>;
}

export interface GatewayAckEnvelope {
  type: 'ack';
  requestId: string;
  accepted: boolean;
  message?: string;
}

export interface GatewayResultEnvelope {
  type: 'result';
  requestId: string;
  success: boolean;
  output?: unknown;
  error?: string;
}

export interface GatewayInboundEnvelope {
  type: 'input';
  target?: string;
  sender?: string;
  blocking?: boolean;
  message: unknown;
}

export interface GatewayEventEnvelope {
  type: 'event';
  name: string;
  payload?: unknown;
}

export type GatewayOutboundEnvelope =
  | GatewayAckEnvelope
  | GatewayResultEnvelope
  | GatewayInboundEnvelope
  | GatewayEventEnvelope;

export interface GatewayProbeResult {
  id: string;
  command: string;
  available: boolean;
  help: {
    supported: boolean;
    ok: boolean;
    exitCode: number | null;
  };
  version: {
    supported: boolean;
    ok: boolean;
    exitCode: number | null;
  };
}
