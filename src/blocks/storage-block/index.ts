import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { BaseBlock, type BlockCapabilities } from '../../core/block.js';

interface SaveArgs {
  key: string;
  value: unknown;
}

interface LoadArgs {
  key: string;
}

export class StorageBlock extends BaseBlock {
  readonly type = 'storage';
  readonly capabilities: BlockCapabilities = {
    functions: ['save', 'load', 'delete', 'exists', 'list'],
    cli: [
      { name: 'save', description: 'Save key-value', args: [] },
      { name: 'load', description: 'Load value by key', args: [] },
      { name: 'delete', description: 'Delete value', args: [] }
    ],
    stateSchema: {
      entries: { type: 'number', readonly: true, description: 'Total entries' },
      backend: { type: 'string', readonly: true, description: 'Storage backend type' }
    }
  };

  private memory: Map<string, unknown> = new Map();
  private backendType: 'memory' | 'file';
  private storagePath: string;

  constructor(id: string, backend: 'memory' | 'file' = 'memory', storagePath = './data/storage') {
    super(id, 'storage');
    this.backendType = backend;
    this.storagePath = storagePath;
  }

  async initialize(): Promise<void> {
    await super.initialize();
    if (this.backendType === 'file' && !existsSync(this.storagePath)) {
      mkdirSync(this.storagePath, { recursive: true });
    }
    this.updateState({ data: { backend: this.backendType, entries: this.memory.size } });
  }

  async execute(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'save': {
        const saveArgs = args as unknown as SaveArgs;
        return this.save(saveArgs);
      }
      case 'load': {
        const loadArgs = args as unknown as LoadArgs;
        return this.load(loadArgs);
      }
      case 'delete':
        return this.delete(args.key as string);
      case 'exists':
        return this.exists(args.key as string);
      case 'list':
        return this.list();
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  save(args: SaveArgs): { saved: boolean; key: string } {
    if (this.backendType === 'memory') {
      this.memory.set(args.key, args.value);
    } else {
      const path = this.getFilePath(args.key);
      if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(args.value, null, 2), 'utf-8');
    }

    this.updateState({ data: { entries: this.memory.size, backend: this.backendType } });
    return { saved: true, key: args.key };
  }

  load(args: LoadArgs): unknown {
    if (this.backendType === 'memory') {
      return this.memory.get(args.key);
    }

    const path = this.getFilePath(args.key);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf-8'));
  }

  delete(key: string): { deleted: boolean } {
    if (this.backendType === 'memory') {
      const deleted = this.memory.delete(key);
      this.updateState({ data: { entries: this.memory.size, backend: this.backendType } });
      return { deleted };
    }

    const path = this.getFilePath(key);
    if (!existsSync(path)) return { deleted: false };
    unlinkSync(path);
    return { deleted: true };
  }

  exists(key: string): { exists: boolean } {
    if (this.backendType === 'memory') {
      return { exists: this.memory.has(key) };
    }
    return { exists: existsSync(this.getFilePath(key)) };
  }

  list(): string[] {
    if (this.backendType === 'memory') {
      return Array.from(this.memory.keys());
    }
    return [];
  }

  private getFilePath(key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9-_]/g, '_');
    return `${this.storagePath}/${safeKey}.json`;
  }
}
