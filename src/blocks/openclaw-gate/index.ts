/**
 * OpenClaw Gate Block
 * 
 * Implements OpenClaw Gate v1.0 protocol compatible layer
 * 
 * Based on Finger three-layer architecture:
 * 1. Block layer (this) - base capability
 * 2. Orchestration layer - composition
 * 3. UI layer - presentation
 */
import fs from 'fs';
import path from 'path';
import { BaseBlock, type BlockCapabilities } from '../../core/block.js';

export interface OpenClawPlugin {
  id: string;
  name: string;
  version: string;
  status: 'installed' | 'enabled' | 'disabled' | 'error';
  metadata: {
    author?: string;
    description?: string;
    category?: string;
    icon?: string;
  };
  tools: OpenClawTool[];
}

export interface OpenClawTool {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}


export interface OpenClawPluginManifest {
  id: string;
  name?: string;
  version?: string;
  status?: 'installed' | 'enabled' | 'disabled' | 'error';
  metadata?: {
    author?: string;
    description?: string;
    category?: string;
    icon?: string;
  };
  tools?: OpenClawTool[];
}

export class OpenClawGateError extends Error {
  code: 'OPENCLAW_PLUGIN_NOT_FOUND' | 'OPENCLAW_PLUGIN_DISABLED' | 'OPENCLAW_TOOL_NOT_FOUND';

  constructor(code: OpenClawGateError['code'], message: string) {
    super(`${code}: ${message}`);
    this.name = 'OpenClawGateError';
    this.code = code;
  }
}

export class OpenClawGateBlock extends BaseBlock {
  readonly type = 'openclaw-gate';
  readonly capabilities: BlockCapabilities = {
    functions: ['installPlugin', 'uninstallPlugin', 'enablePlugin', 'disablePlugin', 'listPlugins', 'callTool'],
    cli: [
      { name: 'list', description: 'List installed plugins', args: [] },
      { name: 'install', description: 'Install a plugin', args: [{ name: 'pluginId', type: 'string', required: true, description: 'Plugin identifier' }] },
      { name: 'uninstall', description: 'Uninstall a plugin', args: [{ name: 'pluginId', type: 'string', required: true, description: 'Plugin identifier' }] },
      { name: 'enable', description: 'Enable a plugin', args: [{ name: 'pluginId', type: 'string', required: true, description: 'Plugin identifier' }] },
      { name: 'disable', description: 'Disable a plugin', args: [{ name: 'pluginId', type: 'string', required: true, description: 'Plugin identifier' }] }
    ],
    stateSchema: {
      plugins: { type: 'number', readonly: true, description: 'Active plugins' },
      tools: { type: 'number', readonly: true, description: 'Available tools' }
    }
  };

  private plugins: Map<string, OpenClawPlugin> = new Map();
  private pluginDir?: string;

  constructor(id: string, options?: { pluginDir?: string }) {
    super(id, 'openclaw-gate');
    this.pluginDir = options?.pluginDir;
    this.loadPlugins();
  }

  async execute(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'installPlugin':
        return this.installPlugin(args.pluginId as string, args.metadata as Record<string, unknown>);
      case 'uninstallPlugin':
        return this.uninstallPlugin(args.pluginId as string);
      case 'enablePlugin':
        return this.enablePlugin(args.pluginId as string);
      case 'disablePlugin':
        return this.disablePlugin(args.pluginId as string);
      case 'listPlugins':
        return this.listPlugins();
      case 'callTool':
        return this.callTool(
          args.pluginId as string,
          args.toolId as string,
          args.input as Record<string, unknown>
        );
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  // --- Plugin lifecycle management ---

  installPlugin(pluginId: string, metadata?: Record<string, unknown>): OpenClawPlugin {
    if (this.plugins.has(pluginId)) {
      throw new Error(`Plugin ${pluginId} already installed`);
    }

    const plugin: OpenClawPlugin = {
      id: pluginId,
      name: (metadata?.name as string) || pluginId,
      version: (metadata?.version as string) || '0.0.1',
      status: 'installed',
      metadata: {
        author: metadata?.author as string,
        description: metadata?.description as string,
        category: metadata?.category as string,
        icon: metadata?.icon as string,
      },
      tools: [],
    };

    this.plugins.set(pluginId, plugin);
    this.updateState({ data: { plugins: this.plugins.size, tools: this.countAvailableTools() } });
    return plugin;
  }

  uninstallPlugin(pluginId: string): { uninstalled: boolean } {
    const uninstalled = this.plugins.delete(pluginId);
    if (uninstalled) {
      this.updateState({ data: { plugins: this.plugins.size, tools: this.countAvailableTools() } });
    }
    return { uninstalled };
  }

  enablePlugin(pluginId: string): OpenClawPlugin {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }
    plugin.status = 'enabled';
    this.updateState({ data: { plugins: this.plugins.size, tools: this.countAvailableTools() } });
    return plugin;
  }

  disablePlugin(pluginId: string): OpenClawPlugin {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }
    plugin.status = 'disabled';
    this.updateState({ data: { plugins: this.plugins.size, tools: this.countAvailableTools() } });
    return plugin;
  }

  listPlugins(): OpenClawPlugin[] {
    return Array.from(this.plugins.values());
  }

  // --- Tool management ---

  addTool(pluginId: string, tool: OpenClawTool): OpenClawTool {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }
    plugin.tools.push(tool);
    this.updateState({ data: { plugins: this.plugins.size, tools: this.countAvailableTools() } });
    return tool;
  }

  listTools(pluginId?: string): OpenClawTool[] {
    if (pluginId) {
      const plugin = this.plugins.get(pluginId);
      return plugin?.tools || [];
    }
    // Return all tools from enabled plugins
    return Array.from(this.plugins.values())
      .filter(p => p.status === 'enabled')
      .flatMap(p => p.tools);
  }

  callTool(pluginId: string, toolId: string, input: Record<string, unknown>): { result: unknown; success: boolean } {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new OpenClawGateError('OPENCLAW_PLUGIN_NOT_FOUND', `Plugin ${pluginId} not found`);
    }
    if (plugin.status !== 'enabled') {
      throw new OpenClawGateError('OPENCLAW_PLUGIN_DISABLED', `Plugin ${pluginId} is not enabled`);
    }
    const tool = plugin.tools.find(t => t.id === toolId);
    if (!tool) {
      throw new OpenClawGateError('OPENCLAW_TOOL_NOT_FOUND', `Tool ${toolId} not found in plugin ${pluginId}`);
    }

    return {
      result: {
        pluginId,
        toolId,
        input,
        status: 'not_implemented',
      },
      success: true,
    };
  }

  // --- Helpers ---

  private countAvailableTools(): number {
    return Array.from(this.plugins.values())
      .filter(p => p.status === 'enabled')
      .reduce((count, p) => count + p.tools.length, 0);
  }

  private loadPlugins(): void {
    if (!this.pluginDir || this.pluginDir.trim().length === 0) {
      this.updateState({ data: { plugins: this.plugins.size, tools: this.countAvailableTools() } });
      return;
    }

    const resolvedPluginDir = this.pluginDir.trim();
    if (!fs.existsSync(resolvedPluginDir)) {
      this.updateState({ data: { plugins: this.plugins.size, tools: this.countAvailableTools() } });
      return;
    }

    const entries = fs.readdirSync(resolvedPluginDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const manifestPath = path.join(resolvedPluginDir, entry.name);
      try {
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(raw) as OpenClawPluginManifest;
        if (!manifest.id || typeof manifest.id !== 'string') continue;

        const plugin: OpenClawPlugin = {
          id: manifest.id,
          name: manifest.name || manifest.id,
          version: manifest.version || '0.0.1',
          status: manifest.status || 'installed',
          metadata: {
            author: manifest.metadata?.author,
            description: manifest.metadata?.description,
            category: manifest.metadata?.category,
            icon: manifest.metadata?.icon,
          },
          tools: Array.isArray(manifest.tools) ? manifest.tools : [],
        };
        this.plugins.set(plugin.id, plugin);
      } catch {
        // ignore malformed manifest during startup
      }
    }

    this.updateState({ data: { plugins: this.plugins.size, tools: this.countAvailableTools() } });
  }
}
