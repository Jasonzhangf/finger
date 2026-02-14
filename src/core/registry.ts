import type { IBlock, BlockRegistration, BlockState, BlockCapabilities } from './block.js';

export interface CliRoute {
  path: string;
  blockType: string;
  blockId: string;
  command: string;
  description: string;
}

export interface ApiEndpoint {
  type: string;
  id: string;
  capabilities: BlockCapabilities;
  state: BlockState;
}

export class BlockRegistry {
  private blocks: Map<string, IBlock> = new Map();
  private registrations: Map<string, BlockRegistration> = new Map();
  private static instance: BlockRegistry | null = null;

  private constructor() {}

  static getInstance(): BlockRegistry {
    if (!BlockRegistry.instance) {
      BlockRegistry.instance = new BlockRegistry();
    }
    return BlockRegistry.instance;
  }

  register(registration: BlockRegistration): void {
    if (this.registrations.has(registration.type)) {
      throw new Error(`Block type ${registration.type} already registered`);
    }
    this.registrations.set(registration.type, registration);
  }

  createInstance(type: string, id: string, config: Record<string, unknown> = {}): IBlock {
    const reg = this.registrations.get(type);
    if (!reg) {
      throw new Error(`Block type ${type} not registered`);
    }

    // Check dependencies
    if (reg.dependencies) {
      for (const dep of reg.dependencies) {
        if (!this.getBlocksByType(dep).length) {
          throw new Error(`Block ${type} requires dependency ${dep} which is not available`);
        }
      }
    }

    const block = reg.factory({ ...config, id });
    this.blocks.set(id, block);
    return block;
  }

  getBlock(id: string): IBlock | undefined {
    return this.blocks.get(id);
  }

  getBlocksByType(type: string): IBlock[] {
    return Array.from(this.blocks.values()).filter(b => b.type === type);
  }

  getAllBlocks(): IBlock[] {
    return Array.from(this.blocks.values());
  }

  getAllStates(): BlockState[] {
    return this.getAllBlocks().map(b => b.getState());
  }

  async execute(blockId: string, command: string, args: Record<string, unknown>): Promise<unknown> {
    const block = this.blocks.get(blockId);
    if (!block) {
      throw new Error(`Block ${blockId} not found`);
    }
    return block.execute(command, args);
  }

  generateCliRoutes(): CliRoute[] {
    const routes: CliRoute[] = [];
    for (const [id, block] of this.blocks) {
      for (const cmd of block.capabilities.cli) {
        routes.push({
          path: `/${block.type}/${id}/${cmd.name}`,
          blockType: block.type,
          blockId: id,
          command: cmd.name,
          description: cmd.description
        });
      }
    }
    return routes;
  }

  generateApiEndpoints(): ApiEndpoint[] {
    return this.getAllBlocks().map(block => ({
      type: block.type,
      id: block.id,
      capabilities: block.capabilities,
      state: block.getState()
    }));
  }

  async initializeAll(): Promise<void> {
    for (const block of this.getAllBlocks()) {
      await block.initialize();
    }
  }

  async startAll(): Promise<void> {
    for (const block of this.getAllBlocks()) {
      await block.start();
    }
  }

  async stopAll(): Promise<void> {
    for (const block of this.getAllBlocks()) {
      await block.stop();
    }
  }

  async destroyAll(): Promise<void> {
    for (const block of this.getAllBlocks()) {
      await block.destroy();
    }
    this.blocks.clear();
  }

  getRegisteredTypes(): string[] {
    return Array.from(this.registrations.keys());
  }
}

export const registry = BlockRegistry.getInstance();
