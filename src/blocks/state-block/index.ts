import { BaseBlock, type BlockCapabilities } from '../../core/block.js';

export class StateBlock extends BaseBlock {
  readonly type = 'state';
  readonly capabilities: BlockCapabilities = {
    functions: ['get', 'set', 'merge', 'delete', 'snapshot'],
    cli: [
      { name: 'get', description: 'Get state value', args: [] },
      { name: 'set', description: 'Set state value', args: [] },
      { name: 'snapshot', description: 'Get full state', args: [] }
    ],
    stateSchema: {
      values: { type: 'object', readonly: false, description: 'Global state values' },
      lastUpdate: { type: 'string', readonly: true, description: 'Last state update time' }
    }
  };

  private store: Map<string, unknown> = new Map();

  constructor(id: string) {
    super(id, 'state');
  }

  async execute(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'get':
        return this.get(args.key as string);
      case 'set':
        return this.set(args.key as string, args.value);
      case 'merge':
        return this.merge(args.key as string, args.value as Record<string, unknown>);
      case 'delete':
        return this.delete(args.key as string);
      case 'snapshot':
        return this.snapshot();
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  get(key: string): unknown {
    return this.store.get(key);
  }

  set(key: string, value: unknown): { key: string; updated: boolean } {
    this.store.set(key, value);
    this.syncState();
    return { key, updated: true };
  }

  merge(key: string, value: Record<string, unknown>): { key: string; merged: boolean } {
    const existing = this.store.get(key);
    if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
      this.store.set(key, { ...(existing as Record<string, unknown>), ...value });
    } else {
      this.store.set(key, value);
    }
    this.syncState();
    return { key, merged: true };
  }

  delete(key: string): { deleted: boolean } {
    const deleted = this.store.delete(key);
    this.syncState();
    return { deleted };
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.store.entries());
  }

  private syncState(): void {
    this.updateState({
      data: {
        values: this.snapshot(),
        lastUpdate: new Date().toISOString()
      }
    });
  }
}
