export const DEFAULT_DAEMON_URL = process.env.FINGER_HUB_URL || 'http://localhost:9999';
export const DEFAULT_WS_URL = process.env.FINGER_WS_URL || 'ws://localhost:9998';
export const DEFAULT_GATEWAY_TARGET = 'chat-gateway';

export const EVENT_GROUPS = [
  'SESSION',
  'TASK',
  'TOOL',
  'DIALOG',
  'PROGRESS',
  'PHASE',
  'HUMAN_IN_LOOP',
  'SYSTEM',
];
