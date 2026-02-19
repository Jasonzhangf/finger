/**
 * Workflow Manager 单例实例
 * 提供全局可访问的 workflow manager
 */
import { WorkflowManager } from './workflow-manager.js';
import { MessageHub } from './message-hub.js';
import { SessionManager } from './session-manager.js';

// 创建共享实例
const messageHub = new MessageHub();
const sessionManager = new SessionManager();

export const workflowManager = new WorkflowManager(messageHub, sessionManager);
