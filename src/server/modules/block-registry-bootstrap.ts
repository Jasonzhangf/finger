import type { BlockRegistry } from '../../core/registry.js';
import {
  TaskBlock,
  AgentBlock,
  EventBusBlock,
  StorageBlock,
  SessionBlock,
  AIBlock,
  ProjectBlock,
  StateBlock,
  OrchestratorBlock,
  WebSocketBlock,
} from '../../blocks/index.js';

export async function initializeBlockRegistry(registry: BlockRegistry): Promise<void> {
  registry.register({ type: 'task', factory: (config) => new TaskBlock(config.id as string), version: '1.0.0' });
  registry.register({ type: 'agent', factory: (config) => new AgentBlock(config.id as string), version: '1.0.0' });
  registry.register({ type: 'eventbus', factory: (config) => new EventBusBlock(config.id as string), version: '1.0.0' });
  registry.register({ type: 'storage', factory: (config) => new StorageBlock(config.id as string), version: '1.0.0' });
  registry.register({ type: 'session', factory: (config) => new SessionBlock(config.id as string), version: '1.0.0' });
  registry.register({ type: 'ai', factory: (config) => new AIBlock(config.id as string), version: '1.0.0' });
  registry.register({ type: 'project', factory: (config) => new ProjectBlock(config.id as string), version: '1.0.0' });
  registry.register({ type: 'state', factory: (config) => new StateBlock(config.id as string), version: '1.0.0' });
  registry.register({ type: 'orchestrator', factory: (config) => new OrchestratorBlock(config.id as string), version: '1.0.0' });
  registry.register({ type: 'websocket', factory: (config) => new WebSocketBlock(config.id as string), version: '1.0.0' });

  registry.createInstance('state', 'state-1');
  registry.createInstance('task', 'task-1');
  registry.createInstance('agent', 'agent-1');
  registry.createInstance('eventbus', 'eventbus-1');
  registry.createInstance('storage', 'storage-1');
  registry.createInstance('session', 'session-1');
  registry.createInstance('ai', 'ai-1');
  registry.createInstance('project', 'project-1');
  registry.createInstance('orchestrator', 'orchestrator-1');
  registry.createInstance('websocket', 'websocket-1');

  await registry.initializeAll();
}
