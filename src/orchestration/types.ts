export type EndpointType = 'input' | 'process' | 'output';

export interface HubMessage<T = unknown> {
  id?: string;
  type?: string;
  sender?: string; // endpoint id or module name
  receiver?: string; // endpoint id or module name
  target?: string; // explicit endpoint id (process.* or output.*)
  payload?: T;
  meta?: Record<string, unknown>;
}

export interface EndpointRef {
  endpointId: string; // format: `${type}.${id}`
  type: EndpointType;
  id: string;
  name: string;
  moduleName: string;
  capabilities?: string[];
}

export type InputHandler = (message: HubMessage) => Promise<unknown>;
export type ProcessHandler = (message: HubMessage) => Promise<ProcessResult>;
export type OutputHandler = (message: HubMessage) => Promise<unknown>;

export interface ProcessResult {
  target?: string;
  message?: HubMessage;
  result?: unknown;
}

export interface InputDef {
  id: string;
  name: string;
  capabilities?: string[];
  handle: InputHandler;
}

export interface ProcessDef {
  id: string;
  name: string;
  capabilities?: string[];
  handle: ProcessHandler;
}

export interface OutputDef {
  id: string;
  name: string;
  capabilities?: string[];
  handle: OutputHandler;
}

export interface ModuleBundle {
  moduleName: string;
  version: string;
  inputs?: InputDef[];
  processes?: ProcessDef[];
  outputs?: OutputDef[];
}

export interface SendOptions {
  blocking?: boolean;
}
