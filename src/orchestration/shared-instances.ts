/**
 * Shared instances - 共享实例
 * 避免模块间创建重复实例
 */
import { MessageHub } from './message-hub.js';
import { SessionManager } from './session-manager.js';
import { WorkflowManager } from './workflow-manager.js';
import { ensureFingerLayout } from '../core/finger-paths.js';

// 全局共享实例
ensureFingerLayout();
export const sharedMessageHub = new MessageHub();
export const sharedSessionManager = new SessionManager();
export const sharedWorkflowManager = new WorkflowManager(sharedMessageHub, sharedSessionManager);

// Re-export from modules for backward compatibility
export { MessageHub } from './message-hub.js';
export { SessionManager } from './session-manager.js';
export { WorkflowManager } from './workflow-manager.js';
