import type { Event } from './types.js';

export interface ArgDef {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required: boolean;
  default?: unknown;
  description: string;
}

export interface CliCommand {
  name: string;
  description: string;
  args: ArgDef[];
}

export interface StateSchema {
  [key: string]: {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    readonly: boolean;
    description: string;
  };
}

export interface BlockCapabilities {
  functions: string[];
  cli: CliCommand[];
  stateSchema: StateSchema;
  events?: string[];
}

export interface BlockState {
  id: string;
  type: string;
  status: 'idle' | 'running' | 'error' | 'stopped';
  health: 'healthy' | 'degraded' | 'unhealthy';
  data: Record<string, unknown>;
  updatedAt: Date;
}

export interface IBlock {
  readonly id: string;
  readonly type: string;
  readonly capabilities: BlockCapabilities;

  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  destroy(): Promise<void>;

  getState(): BlockState;
  execute(command: string, args: Record<string, unknown>): Promise<unknown>;

  onEvent?(event: Event): Promise<void>;
}

export interface BlockRegistration {
  type: string;
  factory: (config: Record<string, unknown>) => IBlock;
  version: string;
  dependencies?: string[];
}

export abstract class BaseBlock implements IBlock {
  abstract readonly type: string;
  abstract readonly capabilities: BlockCapabilities;

  protected state: BlockState;

  constructor(public readonly id: string) {
    this.state = {
      id,
      type: this.type,
      status: 'idle',
      health: 'healthy',
      data: {},
      updatedAt: new Date()
    };
  }

  async initialize(): Promise<void> {
    this.updateState({ status: 'idle', health: 'healthy' });
  }

  async start(): Promise<void> {
    this.updateState({ status: 'running' });
  }

  async stop(): Promise<void> {
    this.updateState({ status: 'stopped' });
  }

  async destroy(): Promise<void> {
    this.updateState({ status: 'stopped' });
  }

  getState(): BlockState {
    return { ...this.state };
  }

  protected updateState(partial: Partial<BlockState>): void {
    this.state = {
      ...this.state,
      ...partial,
      updatedAt: new Date()
    };
  }

  abstract execute(command: string, args: Record<string, unknown>): Promise<unknown>;
}
