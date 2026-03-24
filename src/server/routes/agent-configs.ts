import type { Express } from 'express';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { ensureDir, FINGER_PATHS } from '../../core/finger-paths.js';
import type { AgentJsonConfig, LoadedAgentConfig } from '../../runtime/agent-json-config.js';
import { parseAgentJsonConfig } from '../../runtime/agent-json-config.js';
import { resolveCodingCliBasePrompt } from '../../agents/chat-codex/coding-cli-system-prompt.js';
import { resolveDeveloperPromptTemplateWithSource, type ChatCodexDeveloperRole } from '../../agents/chat-codex/developer-prompt-templates.js';
import { resolveBaseAgentRole } from '../../agents/chat-codex/agent-role-config.js';
import type { AgentRuntimeDeps } from '../modules/agent-runtime/types.js';

export interface AgentConfigRouteDeps {
  getLoadedAgentConfigDir: () => string;
  getLoadedAgentConfigs: () => LoadedAgentConfig[];
  agentJsonSchema: Record<string, unknown>;
  reloadAgentJsonConfigs: (requestedDir?: string) => void;
  getAgentRuntimeDeps: () => AgentRuntimeDeps;
}

export function registerAgentConfigRoutes(app: Express, deps: AgentConfigRouteDeps): void {
  const {
    getLoadedAgentConfigDir,
    getLoadedAgentConfigs,
    agentJsonSchema,
    reloadAgentJsonConfigs,
    getAgentRuntimeDeps,
  } = deps;

  const resolveAgentConfig = (agentId: string): LoadedAgentConfig | null => {
    const normalized = agentId.trim();
    if (!normalized) return null;
    const configs = getLoadedAgentConfigs();
    return configs.find((item) => item.config.id === normalized) ?? null;
  };

  const ensureWithinDir = (filePath: string): boolean => {
    const baseDir = path.resolve(getLoadedAgentConfigDir());
    const resolved = path.resolve(filePath);
    if (resolved === baseDir) return false;
    const withSep = baseDir.endsWith(path.sep) ? baseDir : `${baseDir}${path.sep}`;
    return resolved.startsWith(withSep);
  };

  const ensureWithinFingerHome = (filePath: string): boolean => {
    const homeDir = path.resolve(FINGER_PATHS.home);
    const resolved = path.resolve(filePath);
    if (resolved === homeDir) return false;
    const withSep = homeDir.endsWith(path.sep) ? homeDir : `${homeDir}${path.sep}`;
    return resolved.startsWith(withSep);
  };

  const resolveNewAgentConfigPath = (agentId: string): string | null => {
    const safeId = path.basename(agentId);
    if (safeId !== agentId) return null;
    const target = path.join(getLoadedAgentConfigDir(), safeId, 'agent.json');
    return ensureWithinDir(target) ? target : null;
  };

  const resolvePromptRole = (agentId: string, loaded?: LoadedAgentConfig | null): ChatCodexDeveloperRole => {
    const roleHint = typeof loaded?.config.role === 'string' && loaded.config.role.trim().length > 0
      ? loaded.config.role.trim()
      : agentId;
    const normalized = roleHint.trim().toLowerCase();
    if (normalized.includes('router')) return 'router';
    const baseRole = resolveBaseAgentRole(roleHint);
    return baseRole === 'reviewer' ? 'reviewer' : 'orchestrator';
  };

  const resolveAgentConfigFilePath = (agentId: string, loaded?: LoadedAgentConfig | null): string => {
    if (loaded?.filePath && ensureWithinFingerHome(loaded.filePath)) {
      return loaded.filePath;
    }
    return path.join(FINGER_PATHS.runtime.agentsDir, agentId, 'agent.json');
  };

  const resolveAgentRootDir = (agentId: string, loaded?: LoadedAgentConfig | null): string => {
    return path.dirname(resolveAgentConfigFilePath(agentId, loaded));
  };

  const resolvePromptOverridePath = (
    agentId: string,
    promptType: 'system' | 'developer',
    role: ChatCodexDeveloperRole,
    loaded?: LoadedAgentConfig | null,
  ): string => {
    const configuredPath = promptType === 'system'
      ? loaded?.config.prompts?.system
      : loaded?.config.prompts?.developer;
    if (typeof configuredPath === 'string' && configuredPath.trim().length > 0) {
      const agentRoot = resolveAgentRootDir(agentId, loaded);
      const candidate = path.isAbsolute(configuredPath)
        ? path.resolve(configuredPath)
        : path.resolve(agentRoot, configuredPath);
      if (ensureWithinFingerHome(candidate)) {
        return candidate;
      }
    }
    return promptType === 'system'
      ? path.join(resolveAgentRootDir(agentId, loaded), 'prompts', 'prompt.md')
      : path.join(resolveAgentRootDir(agentId, loaded), 'prompts', 'dev', `${role}.md`);
  };

  const buildPromptPathsConfig = (
    agentId: string,
    role: ChatCodexDeveloperRole,
    loaded?: LoadedAgentConfig | null,
  ): NonNullable<AgentJsonConfig['prompts']> => {
    const agentRoot = resolveAgentRootDir(agentId, loaded);
    const systemAbsolute = resolvePromptOverridePath(agentId, 'system', role, loaded);
    const developerAbsolute = resolvePromptOverridePath(agentId, 'developer', role, loaded);
    return {
      system: path.relative(agentRoot, systemAbsolute) || 'prompts/prompt.md',
      developer: path.relative(agentRoot, developerAbsolute) || `prompts/dev/${role}.md`,
    };
  };

  const writeAgentJsonConfig = (agentId: string, config: AgentJsonConfig, loaded?: LoadedAgentConfig | null): string => {
    const targetPath = resolveAgentConfigFilePath(agentId, loaded);
    ensureDir(path.dirname(targetPath));
    writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
    return targetPath;
  };

  const buildPromptSnapshot = (agentId: string, loaded?: LoadedAgentConfig | null) => {
    const role = resolvePromptRole(agentId, loaded);
    const systemEditablePath = resolvePromptOverridePath(agentId, 'system', role, loaded);
    const developerEditablePath = resolvePromptOverridePath(agentId, 'developer', role, loaded);
    const systemResolved = resolveCodingCliBasePrompt(systemEditablePath);
    const developerResolved = resolveDeveloperPromptTemplateWithSource(role, developerEditablePath);
    return {
      system: {
        role,
        source: systemResolved.source,
        path: systemResolved.path ?? '',
        editablePath: systemEditablePath,
        content: systemResolved.prompt,
      },
      developer: {
        role,
        source: developerResolved.source,
        path: developerResolved.path ?? '',
        editablePath: developerEditablePath,
        content: developerResolved.prompt,
      },
    };
  };

  app.get('/api/v1/agents/configs', (_req, res) => {
    const dir = getLoadedAgentConfigDir();
    const configs = getLoadedAgentConfigs();
    res.json({
      success: true,
      dir,
      schema: agentJsonSchema,
      agents: configs.map((item) => ({
        filePath: item.filePath,
        id: item.config.id,
        name: item.config.name,
        role: item.config.role,
        enabled: item.config.enabled,
        tools: item.config.tools ?? {},
      })),
    });
  });

  app.get('/api/v1/agents/configs/:agentId', (req, res) => {
    const agentId = typeof req.params.agentId === 'string' ? req.params.agentId.trim() : '';
    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    const found = resolveAgentConfig(agentId);
    if (!found) {
      const targetPath = resolveNewAgentConfigPath(agentId);
      if (!targetPath) {
        res.status(400).json({ error: 'agentId is invalid' });
        return;
      }
      res.json({
        success: true,
        agentId,
        filePath: targetPath,
        config: { id: agentId },
        missing: true,
        prompts: buildPromptSnapshot(agentId, null),
      });
      return;
    }
    if (!ensureWithinDir(found.filePath)) {
      res.status(400).json({ error: 'agent config path is invalid' });
      return;
    }
    try {
      const raw = readFileSync(found.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      res.json({
        success: true,
        agentId: found.config.id,
        filePath: found.filePath,
        config: parsed,
        prompts: buildPromptSnapshot(found.config.id, found),
        missing: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/v1/agents/configs/:agentId/prompts', (req, res) => {
    const agentId = typeof req.params.agentId === 'string' ? req.params.agentId.trim() : '';
    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    const found = resolveAgentConfig(agentId);
    res.json({
      success: true,
      agentId,
      prompts: buildPromptSnapshot(agentId, found),
    });
  });

  app.put('/api/v1/agents/configs/:agentId/prompts', (req, res) => {
    const agentId = typeof req.params.agentId === 'string' ? req.params.agentId.trim() : '';
    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    const found = resolveAgentConfig(agentId);
    const systemPrompt = req.body?.systemPrompt;
    const developerPrompt = req.body?.developerPrompt;
    const requestedRole = typeof req.body?.developerRole === 'string' ? req.body.developerRole.trim() : '';
    if (systemPrompt !== undefined && typeof systemPrompt !== 'string') {
      res.status(400).json({ error: 'systemPrompt must be string when provided' });
      return;
    }
    if (developerPrompt !== undefined && typeof developerPrompt !== 'string') {
      res.status(400).json({ error: 'developerPrompt must be string when provided' });
      return;
    }
    if (systemPrompt === undefined && developerPrompt === undefined) {
      res.status(400).json({ error: 'systemPrompt or developerPrompt is required' });
      return;
    }

    const role = requestedRole
      ? (resolveBaseAgentRole(requestedRole) === 'reviewer' ? 'reviewer' : 'orchestrator')
      : resolvePromptRole(agentId, found);
    const systemPath = resolvePromptOverridePath(agentId, 'system', role, found);
    const developerPath = resolvePromptOverridePath(agentId, 'developer', role, found);

    try {
      if (systemPrompt !== undefined) {
        ensureDir(path.dirname(systemPath));
        writeFileSync(systemPath, `${systemPrompt.trimEnd()}\n`, 'utf-8');
      }
      if (developerPrompt !== undefined) {
        ensureDir(path.dirname(developerPath));
        writeFileSync(developerPath, `${developerPrompt.trimEnd()}\n`, 'utf-8');
      }
      const currentConfig = found?.config ?? { id: agentId };
      const nextConfig: AgentJsonConfig = {
        ...currentConfig,
        id: agentId,
        prompts: buildPromptPathsConfig(agentId, role, found),
      };
      const configPath = writeAgentJsonConfig(agentId, nextConfig, found);
      reloadAgentJsonConfigs();
      res.json({
        success: true,
        role,
        configPath,
        ...(systemPrompt !== undefined ? { systemPath } : {}),
        ...(developerPrompt !== undefined ? { developerPath } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.put('/api/v1/agents/configs/:agentId', (req, res) => {
    const agentId = typeof req.params.agentId === 'string' ? req.params.agentId.trim() : '';
    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    const found = resolveAgentConfig(agentId);
    const targetPath = found?.filePath || resolveNewAgentConfigPath(agentId);
    if (!targetPath) {
      res.status(400).json({ error: 'agent config path is invalid' });
      return;
    }
    if (!ensureWithinDir(targetPath)) {
      res.status(400).json({ error: 'agent config path is invalid' });
      return;
    }
    const nextConfig = req.body?.config ?? req.body;
    try {
      parseAgentJsonConfig(nextConfig, targetPath);
      const nextId = typeof (nextConfig as { id?: unknown })?.id === 'string'
        ? String((nextConfig as { id?: unknown }).id).trim()
        : '';
      if (nextId && nextId !== agentId) {
        res.status(400).json({ error: `agentId mismatch: ${agentId} != ${nextId}` });
        return;
      }
      writeFileSync(targetPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf-8');
      reloadAgentJsonConfigs();

      const enabled = typeof (nextConfig as { enabled?: unknown }).enabled === 'boolean'
        ? (nextConfig as { enabled: boolean }).enabled
        : true;
      if (!enabled) {
        void getAgentRuntimeDeps().agentRuntimeBlock.execute('deploy', {
          targetAgentId: agentId,
          config: { enabled: false },
        });
      }

      res.json({ success: true, filePath: targetPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.patch('/api/v1/agents/configs/:agentId/enabled', (req, res) => {
    const agentId = typeof req.params.agentId === 'string' ? req.params.agentId.trim() : '';
    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }

    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled(boolean) is required' });
      return;
    }

    const found = resolveAgentConfig(agentId);
    const targetPath = found?.filePath || resolveNewAgentConfigPath(agentId);
    if (!targetPath || !ensureWithinDir(targetPath)) {
      res.status(400).json({ error: 'agent config path is invalid' });
      return;
    }

    try {
      const currentConfig: AgentJsonConfig = found?.config ?? { id: agentId };
      const nextConfig: AgentJsonConfig = {
        ...currentConfig,
        id: agentId,
        enabled,
      };
      parseAgentJsonConfig(nextConfig, targetPath);
      writeFileSync(targetPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf-8');
      reloadAgentJsonConfigs();

      if (!enabled) {
        void getAgentRuntimeDeps().agentRuntimeBlock.execute('deploy', {
          targetAgentId: agentId,
          config: { enabled: false },
        });
      }

      res.json({
        success: true,
        agentId,
        enabled,
        filePath: targetPath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/v1/agents/configs/schema', (_req, res) => {
    res.json({ success: true, schema: agentJsonSchema });
  });

  // POST /api/v1/agents/configs/create - Create new agent from template
  app.post('/api/v1/agents/configs/create', async (req, res) => {
    const { agentId, name, role, templateId } = req.body;
    if (!agentId || typeof agentId !== 'string' || agentId.trim().length === 0) {
      res.status(400).json({ error: 'agentId (string) is required' });
      return;
    }
    const safeAgentId = path.basename(agentId.trim());
    if (safeAgentId !== agentId.trim()) {
      res.status(400).json({ error: 'agentId contains invalid characters' });
      return;
    }
    const existingConfig = resolveAgentConfig(safeAgentId);
    if (existingConfig) {
      res.status(409).json({ error: `Agent "${safeAgentId}" already exists` });
      return;
    }
    const template = templateId && resolveAgentConfig(templateId)
      ? resolveAgentConfig(templateId)
      : resolveAgentConfig('finger-project-agent');
    if (!template) {
      res.status(404).json({ error: 'Template not found (neither finger-project-agent nor specified template exists)' });
      return;
    }
    try {
      const targetPath = resolveNewAgentConfigPath(safeAgentId);
      if (!targetPath) {
        res.status(400).json({ error: 'Invalid agent config path' });
        return;
      }
      const newConfig = {
        ...template.config,
        id: safeAgentId,
        name: name ?? safeAgentId,
        role: role ?? 'project',
        enabled: true,
        instanceCount: 1,
      };
      ensureDir(path.dirname(targetPath));
      writeFileSync(targetPath, JSON.stringify(newConfig, null, 2), 'utf-8');
      reloadAgentJsonConfigs(getLoadedAgentConfigDir());
      res.json({ success: true, agentId: safeAgentId, filePath: targetPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: `Failed to create agent: ${message}` });
    }
  });

  app.post('/api/v1/agents/configs/reload', (req, res) => {
    const requestedDir = req.body?.dir;
    if (requestedDir !== undefined && typeof requestedDir !== 'string') {
      res.status(400).json({ error: 'dir must be string when provided' });
      return;
    }

    try {
      reloadAgentJsonConfigs(requestedDir || getLoadedAgentConfigDir());
      const configs = getLoadedAgentConfigs();
      res.json({
        success: true,
        dir: getLoadedAgentConfigDir(),
        count: configs.length,
        agents: configs.map((item) => ({
          filePath: item.filePath,
          id: item.config.id,
          role: item.config.role,
          enabled: item.config.enabled,
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });
}
