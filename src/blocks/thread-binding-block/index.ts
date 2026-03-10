import { BaseBlock, type BlockCapabilities } from '../../core/block.js';

interface ThreadBinding {
  id: string;
  channel: string;
  accountId?: string;
  threadId: string;
  sessionId: string;
  runtimeSessionId?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export class ThreadBindingBlock extends BaseBlock {
  readonly type = 'thread-binding';
  readonly capabilities: BlockCapabilities = {
    functions: ['bind', 'unbind', 'get', 'list', 'listBySession', 'listByChannel'],
    cli: [
      { name: 'bind', description: 'Bind channel/thread to session', args: [] },
      { name: 'unbind', description: 'Unbind channel/thread from session', args: [] },
      { name: 'get', description: 'Get binding by channel/thread', args: [] },
      { name: 'list', description: 'List all bindings', args: [] }
    ],
    stateSchema: {
      bindings: { type: 'number', readonly: true, description: 'Active thread bindings' }
    }
  };

  private bindings: Map<string, ThreadBinding> = new Map();
  // 索引：channel+threadId -> binding
  private channelThreadIndex: Map<string, string> = new Map();
  // 索引：sessionId -> bindingId[]
  private sessionIndex: Map<string, string[]> = new Map();
  // 索引：channel -> bindingId[]
  private channelIndex: Map<string, string[]> = new Map();

  constructor(id: string) {
    super(id, 'thread-binding');
  }

  async execute(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'bind':
        return this.bind(
          args.channel as string,
          args.threadId as string,
          args.sessionId as string,
          {
            accountId: args.accountId as string,
            runtimeSessionId: args.runtimeSessionId as string,
            metadata: args.metadata as Record<string, unknown>
          }
        );
      case 'unbind':
        return this.unbind(args.channel as string, args.threadId as string);
      case 'get':
        return this.get(args.channel as string, args.threadId as string);
      case 'list':
        return this.list();
      case 'listBySession':
        return this.listBySession(args.sessionId as string);
      case 'listByChannel':
        return this.listByChannel(args.channel as string);
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  bind(
    channel: string,
    threadId: string,
    sessionId: string,
    options?: {
      accountId?: string;
      runtimeSessionId?: string;
      metadata?: Record<string, unknown>;
    }
  ): ThreadBinding {
    const channelThreadKey = `${channel}:${threadId}`;
    const existingId = this.channelThreadIndex.get(channelThreadKey);

    if (existingId) {
      // 更新现有绑定
      const existing = this.bindings.get(existingId)!;
      const updated: ThreadBinding = {
        ...existing,
        sessionId,
        runtimeSessionId: options?.runtimeSessionId,
        accountId: options?.accountId,
        metadata: options?.metadata,
        updatedAt: new Date().toISOString()
      };
      this.bindings.set(existingId, updated);
      return updated;
    }

    // 创建新绑定
    const id = `binding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const binding: ThreadBinding = {
      id,
      channel,
      threadId,
      sessionId,
      accountId: options?.accountId,
      runtimeSessionId: options?.runtimeSessionId,
      metadata: options?.metadata,
      createdAt: now,
      updatedAt: now
    };

    this.bindings.set(id, binding);
    this.channelThreadIndex.set(channelThreadKey, id);

    // 更新 session 索引
    if (!this.sessionIndex.has(sessionId)) {
      this.sessionIndex.set(sessionId, []);
    }
    this.sessionIndex.get(sessionId)!.push(id);

    // 更新 channel 索引
    if (!this.channelIndex.has(channel)) {
      this.channelIndex.set(channel, []);
    }
    this.channelIndex.get(channel)!.push(id);

    this.updateState({ data: { bindings: this.bindings.size } });
    return binding;
  }

  unbind(channel: string, threadId: string): { unbound: boolean } {
    const channelThreadKey = `${channel}:${threadId}`;
    const bindingId = this.channelThreadIndex.get(channelThreadKey);

    if (!bindingId) {
      return { unbound: false };
    }

    const binding = this.bindings.get(bindingId);
    if (!binding) {
      return { unbound: false };
    }

    // 删除主绑定
    this.bindings.delete(bindingId);
    // 删除 channel/thread 索引
    this.channelThreadIndex.delete(channelThreadKey);

    // 清理 session 索引
    const sessionBindings = this.sessionIndex.get(binding.sessionId);
    if (sessionBindings) {
      this.sessionIndex.set(
        binding.sessionId,
        sessionBindings.filter(id => id !== bindingId)
      );
      if (this.sessionIndex.get(binding.sessionId)!.length === 0) {
        this.sessionIndex.delete(binding.sessionId);
      }
    }

    // 清理 channel 索引
    const channelBindings = this.channelIndex.get(binding.channel);
    if (channelBindings) {
      this.channelIndex.set(
        binding.channel,
        channelBindings.filter(id => id !== bindingId)
      );
      if (this.channelIndex.get(binding.channel)!.length === 0) {
        this.channelIndex.delete(binding.channel);
      }
    }

    this.updateState({ data: { bindings: this.bindings.size } });
    return { unbound: true };
  }

  get(channel: string, threadId: string): ThreadBinding | undefined {
    const channelThreadKey = `${channel}:${threadId}`;
    const bindingId = this.channelThreadIndex.get(channelThreadKey);
    if (!bindingId) return undefined;
    return this.bindings.get(bindingId);
  }

  list(): ThreadBinding[] {
    return Array.from(this.bindings.values());
  }

  listBySession(sessionId: string): ThreadBinding[] {
    const bindingIds = this.sessionIndex.get(sessionId);
    if (!bindingIds) return [];
    return bindingIds.map(id => this.bindings.get(id)!).filter(Boolean);
  }

  listByChannel(channel: string): ThreadBinding[] {
    const bindingIds = this.channelIndex.get(channel);
    if (!bindingIds) return [];
    return bindingIds.map(id => this.bindings.get(id)!).filter(Boolean);
  }
}
