import { isRecord } from './utils.js';

export function extractPanelReply(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }

  if (!isRecord(result)) {
    return JSON.stringify(result);
  }

  if (typeof result.response === 'string') {
    return result.response;
  }

  if (typeof result.output === 'string') {
    return result.output;
  }

  if (isRecord(result.output) && typeof result.output.response === 'string') {
    return result.output.response;
  }

  if (typeof result.error === 'string' && result.error.length > 0) {
    return `Error: ${result.error}`;
  }

  return JSON.stringify(result, null, 2);
}
