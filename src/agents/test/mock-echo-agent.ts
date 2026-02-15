import type { InputModule, OutputModule } from '../../orchestration/module-registry.js';

export type EchoMessage = {
  type?: string;
  text?: string;
  sender?: string;
  receiver?: string;
  [key: string]: unknown;
};

export const echoInput: InputModule = {
  id: 'echo-input',
  type: 'input',
  name: 'echo-input',
  version: '1.0.0',
  handle: async (message: EchoMessage) => {
    return {
      received: message,
      handler: 'echo-input'
    };
  },
  defaultRoutes: ['echo-output']
};

export const echoOutput: OutputModule = {
  id: 'echo-output',
  type: 'output',
  name: 'echo-output',
  version: '1.0.0',
  handle: async (message: EchoMessage, callback?: (result: unknown) => void) => {
    const result = {
      type: 'echo-reply',
      echo: message,
      text: message.text ?? null,
      timestamp: Date.now(),
      handler: 'echo-output'
    };

    if (callback) {
      callback(result);
    }

    return result;
  }
};

export default [echoInput, echoOutput];
