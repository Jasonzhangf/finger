import type { Express } from 'express';
import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
import type { ToolRegistry } from '../../runtime/tool-registry.js';
import { isObjectRecord } from '../common/object.js';

export interface ToolRouteDeps {
  toolRegistry: ToolRegistry;
  runtime: RuntimeFacade;
}

export function registerToolRoutes(app: Express, deps: ToolRouteDeps): void {
  const { toolRegistry, runtime } = deps;

  app.get('/api/v1/tools', (_req, res) => {
    const tools = toolRegistry.list();
    res.json({ success: true, tools });
  });

  app.put('/api/v1/tools/:name/policy', (req, res) => {
    const { policy } = req.body as { policy?: string };
    if (policy !== 'allow' && policy !== 'deny') {
      res.status(400).json({ error: 'Invalid policy. Must be "allow" or "deny"' });
      return;
    }
    const success = toolRegistry.setPolicy(req.params.name, policy);
    if (!success) {
      res.status(404).json({ error: 'Tool not found' });
      return;
    }
    res.json({ success: true, name: req.params.name, policy });
  });

  app.put('/api/v1/tools/:name/authorization', (req, res) => {
    const required = req.body?.required;
    if (typeof required !== 'boolean') {
      res.status(400).json({ error: 'required must be boolean' });
      return;
    }
    runtime.setToolAuthorizationRequired(req.params.name, required);
    res.json({ success: true, name: req.params.name, required });
  });

  app.post('/api/v1/tools/authorizations', (req, res) => {
    const agentId = req.body?.agentId;
    const toolName = req.body?.toolName;
    const issuedBy = req.body?.issuedBy;
    const ttlMs = req.body?.ttlMs;
    const maxUses = req.body?.maxUses;

    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    if (typeof toolName !== 'string' || toolName.trim().length === 0) {
      res.status(400).json({ error: 'toolName is required' });
      return;
    }
    if (typeof issuedBy !== 'string' || issuedBy.trim().length === 0) {
      res.status(400).json({ error: 'issuedBy is required' });
      return;
    }

    const grant = runtime.issueToolAuthorization(agentId, toolName, issuedBy, {
      ttlMs: typeof ttlMs === 'number' ? ttlMs : undefined,
      maxUses: typeof maxUses === 'number' ? maxUses : undefined,
    });

    res.json({ success: true, authorization: grant });
  });

  app.delete('/api/v1/tools/authorizations/:token', (req, res) => {
    const revoked = runtime.revokeToolAuthorization(req.params.token);
    if (!revoked) {
      res.status(404).json({ error: 'authorization token not found' });
      return;
    }
    res.json({ success: true, token: req.params.token });
  });

  app.post('/api/v1/tools/execute', async (req, res) => {
    const agentId = req.body?.agentId;
    const toolName = req.body?.toolName;
    const input = req.body?.input;
    const authorizationToken = req.body?.authorizationToken;

    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    if (typeof toolName !== 'string' || toolName.trim().length === 0) {
      res.status(400).json({ error: 'toolName is required' });
      return;
    }
    if (authorizationToken !== undefined && typeof authorizationToken !== 'string') {
      res.status(400).json({ error: 'authorizationToken must be string when provided' });
      return;
    }

    try {
      const executionInput = toolName === 'user.ask' && isObjectRecord(input)
        ? {
            ...input,
            ...(typeof input.agent_id === 'string' && input.agent_id.trim().length > 0
              ? {}
              : { agent_id: agentId }),
          }
        : input;
      const result = await runtime.callTool(agentId, toolName, executionInput, { authorizationToken });
      res.json({ success: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/v1/tools/register', (req, res) => {
    const { name, description, inputSchema, handler, policy } = req.body as {
      name?: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
      handler?: (input: unknown) => Promise<unknown>;
      policy?: string;
    };
    if (!name || typeof handler !== 'function') {
      res.status(400).json({ error: 'Missing name or handler' });
      return;
    }
    toolRegistry.register({
      name,
      description: description || '',
      inputSchema: inputSchema || {},
      policy: policy === 'deny' ? 'deny' : 'allow',
      handler,
    });
    res.json({ success: true, name, policy: policy || 'allow' });
  });

  app.get('/api/v1/tools/agents/:agentId/policy', (req, res) => {
    const policy = runtime.getAgentToolPolicy(req.params.agentId);
    res.json({ success: true, policy });
  });

  app.put('/api/v1/tools/agents/:agentId/policy', (req, res) => {
    const whitelistRaw = req.body?.whitelist;
    const blacklistRaw = req.body?.blacklist;

    if (whitelistRaw !== undefined && !Array.isArray(whitelistRaw)) {
      res.status(400).json({ error: 'whitelist must be string[]' });
      return;
    }
    if (blacklistRaw !== undefined && !Array.isArray(blacklistRaw)) {
      res.status(400).json({ error: 'blacklist must be string[]' });
      return;
    }

    const whitelist = Array.isArray(whitelistRaw)
      ? whitelistRaw.filter((item): item is string => typeof item === 'string')
      : undefined;
    const blacklist = Array.isArray(blacklistRaw)
      ? blacklistRaw.filter((item): item is string => typeof item === 'string')
      : undefined;

    if (whitelist) {
      runtime.setAgentToolWhitelist(req.params.agentId, whitelist);
    }
    if (blacklist) {
      runtime.setAgentToolBlacklist(req.params.agentId, blacklist);
    }

    const policy = runtime.getAgentToolPolicy(req.params.agentId);
    res.json({ success: true, policy });
  });

  app.post('/api/v1/tools/agents/:agentId/grant', (req, res) => {
    const toolName = req.body?.toolName;
    if (typeof toolName !== 'string' || toolName.trim().length === 0) {
      res.status(400).json({ error: 'toolName is required' });
      return;
    }
    const policy = runtime.grantToolToAgent(req.params.agentId, toolName);
    res.json({ success: true, policy });
  });

  app.post('/api/v1/tools/agents/:agentId/revoke', (req, res) => {
    const toolName = req.body?.toolName;
    if (typeof toolName !== 'string' || toolName.trim().length === 0) {
      res.status(400).json({ error: 'toolName is required' });
      return;
    }
    const policy = runtime.revokeToolFromAgent(req.params.agentId, toolName);
    res.json({ success: true, policy });
  });

  app.post('/api/v1/tools/agents/:agentId/deny', (req, res) => {
    const toolName = req.body?.toolName;
    if (typeof toolName !== 'string' || toolName.trim().length === 0) {
      res.status(400).json({ error: 'toolName is required' });
      return;
    }
    const policy = runtime.denyToolForAgent(req.params.agentId, toolName);
    res.json({ success: true, policy });
  });

  app.post('/api/v1/tools/agents/:agentId/allow', (req, res) => {
    const toolName = req.body?.toolName;
    if (typeof toolName !== 'string' || toolName.trim().length === 0) {
      res.status(400).json({ error: 'toolName is required' });
      return;
    }
    const policy = runtime.allowToolForAgent(req.params.agentId, toolName);
    res.json({ success: true, policy });
  });

  app.get('/api/v1/tools/agents/presets', (_req, res) => {
    res.json({ success: true, presets: runtime.listRoleToolPolicyPresets() });
  });

  app.post('/api/v1/tools/agents/:agentId/role-policy', (req, res) => {
    const role = req.body?.role;
    if (typeof role !== 'string' || role.trim().length === 0) {
      res.status(400).json({ error: 'role is required' });
      return;
    }

    try {
      const policy = runtime.applyAgentRoleToolPolicy(req.params.agentId, role);
      res.json({ success: true, role, policy });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });
}
