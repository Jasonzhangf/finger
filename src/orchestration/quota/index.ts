/**
 * Quota Module Entry - 配额模块入口
 * 
 * Phase 1: 串行验证模式
 */

// Types
export type {
  QuotaPolicyV1,
  AgentConfigV1,
  RuntimeInstanceV1,
  RuntimeStatus,
  SessionBindingV1,
  QuotaResolution,
} from './types.js';

export { getEffectiveQuota } from './types.js';

// Serial Policy
export { 
  SERIAL_VALIDATION_POLICY, 
  isSerialValidationMode,
  getQueueDescription,
} from './serial-policy.js';

// Runtime Queue
export { RuntimeQueue, runtimeQueue } from './runtime-queue.js';

// Events
export type {
  RuntimeEventType,
  RuntimeEvent,
  RuntimeSpawnedEvent,
  RuntimeStatusChangedEvent,
  RuntimeFinishedEvent,
} from './events.js';

export {
  runtimeEventEmitter,
  createSpawnedEvent,
  createStatusChangedEvent,
  createFinishedEvent,
} from './events.js';
