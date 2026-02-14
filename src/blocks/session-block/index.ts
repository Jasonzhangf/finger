import { BaseBlock, type BlockCapabilities } from '../../core/block.js';

interface Session {
  id: string;
  taskId: string;
  context: Record<string, unknown>;
  createdAt: Date;
  lastAccessedAt: Date;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
}

export class SessionBlock extends BaseBlock {
  readonly type = 'session';
  readonly capabilities: BlockCapabilities = {
    functions: ['create', 'get', 'update', 'delete', 'addMessage', 'getMessages'],
    cli: [
      { name: 'create', description: 'Create session', args: [] },
      { name: 'get', description: 'Get session', args: [] },
      { name: 'list', description: 'List sessions', args: [] }
    ],
    stateSchema: {
      sessions: { type: 'number', readonly: true, description: 'Active sessions' }
    }
  };

  private sessions: Map<string, Session> = new Map();

  constructor(id: string) {
    super(id, 'session');
  }

  async execute(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'create':
        return this.create(args.taskId as string, args.context as Record<string, unknown>);
      case 'get':
        return this.get(args.sessionId as string);
      case 'update':
        return this.update(args.sessionId as string, args.context as Record<string, unknown>);
      case 'delete':
        return this.delete(args.sessionId as string);
      case 'addMessage':
        return this.addMessage(
          args.sessionId as string,
          args.role as 'user' | 'assistant' | 'system',
          args.content as string
        );
      case 'getMessages':
        return this.getMessages(args.sessionId as string);
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  create(taskId: string, context: Record<string, unknown> = {}): Session {
    const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session: Session = {
      id,
      taskId,
      context,
      createdAt: new Date(),
      lastAccessedAt: new Date(),
      messages: []
    };

    this.sessions.set(id, session);
    this.updateState({ data: { sessions: this.sessions.size } });
    return session;
  }

  get(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastAccessedAt = new Date();
    }
    return session;
  }

  update(sessionId: string, context: Record<string, unknown>): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.context = { ...session.context, ...context };
    session.lastAccessedAt = new Date();
    return session;
  }

  delete(sessionId: string): { deleted: boolean } {
    const deleted = this.sessions.delete(sessionId);
    this.updateState({ data: { sessions: this.sessions.size } });
    return { deleted };
  }

  addMessage(sessionId: string, role: 'user' | 'assistant' | 'system', content: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.messages.push({ role, content });
    session.lastAccessedAt = new Date();
    return session;
  }

  getMessages(sessionId: string): Array<{ role: string; content: string }> {
    const session = this.sessions.get(sessionId);
    return session?.messages || [];
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }
}
