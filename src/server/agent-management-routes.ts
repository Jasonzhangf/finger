/**
 * Agent Management Routes - Agent 进程管理 API
 * 
 * 1. 注册/注销 Agent
 * 2. 心跳接收
 * 3. 进程列表查询
 */

import type { Express, Request, Response } from 'express';
import { logger } from '../core/logger.js';
import { processRegistry } from '../daemon/process-manager/process-registry.js';

const log = logger.module('AgentManagementRoutes');

export function registerAgentManagementRoutes(app: Express): void {
  
  // Agent 注册
  app.post('/api/v1/agents/register', async (req: Request, res: Response) => {
    try {
      const { agentId, agentName, pid, capabilities } = req.body;

      if (!agentId || !pid) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: agentId, pid',
        });
      }

      const registration = await processRegistry.registerAgent({
        agentId,
        agentName: agentName || agentId,
        pid,
        capabilities: capabilities || [],
      });

      log.info(`Agent registered via API: ${agentId} (PID: ${pid})`);
      
      res.json({
        success: true,
        agentId: registration.agentId,
        status: registration.status,
        registeredAt: registration.registeredAt,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Agent registration failed:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Agent 注销
  app.post('/api/v1/agents/unregister', async (req: Request, res: Response) => {
    try {
      const { agentId, reason } = req.body;

      if (!agentId) {
        return res.status(400).json({
          success: false,
          error: 'Missing required field: agentId',
        });
      }

      const success = await processRegistry.unregisterAgent(agentId, reason);

      log.info(`Agent unregistered via API: ${agentId} (${reason || 'unknown'})`);
      
      res.json({
        success,
        agentId,
        reason,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Agent unregistration failed:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Agent 心跳
  app.post('/api/v1/agents/heartbeat', async (req: Request, res: Response) => {
    try {
      const { agentId, pid } = req.body;

      if (!agentId || !pid) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: agentId, pid',
        });
      }

      const success = processRegistry.updateHeartbeat(agentId);

      // 检查是否需要发送命令给 Agent
      let command: string | undefined;

      // TODO: 从某个命令队列获取待发送命令
      // if (agent && hasPendingCommand(agentId)) {
      //   command = getPendingCommand(agentId);
      // }

      res.json({
        success,
        timestamp: new Date().toISOString(),
        command,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Heartbeat processing failed:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 获取所有 Agent 列表
  app.get('/api/v1/agents', async (req: Request, res: Response) => {
    try {
      const agents = processRegistry.getAgents();
      
      res.json({
        success: true,
        agents: agents.map(a => ({
          agentId: a.agentId,
          agentName: a.agentName,
          pid: a.pid,
          status: a.status,
          registeredAt: a.registeredAt,
          lastHeartbeat: a.lastHeartbeat,
          capabilities: a.capabilities,
        })),
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Failed to get agents:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 获取单个 Agent 信息
  app.get('/api/v1/agents/:agentId', async (req: Request, res: Response) => {
    try {
      const agentId = Array.isArray(req.params.agentId) ? req.params.agentId[0] : req.params.agentId;
      const agent = processRegistry.getAgent(agentId);

      if (!agent) {
        return res.status(404).json({
          success: false,
          error: `Agent ${agentId} not found`,
        });
      }

      res.json({
        success: true,
        agent: {
          agentId: agent.agentId,
          agentName: agent.agentName,
          pid: agent.pid,
          status: agent.status,
          registeredAt: agent.registeredAt,
          lastHeartbeat: agent.lastHeartbeat,
          capabilities: agent.capabilities,
        },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Failed to get agent:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 启动 Agent 进程
  app.post('/api/v1/agents/start', async (req: Request, res: Response) => {
    try {
      const { agentId, agentName, entryScript, args, env } = req.body;

      if (!agentId || !entryScript) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: agentId, entryScript',
        });
      }

      const info = await processRegistry.startAgentProcess({
        agentId,
        agentName: agentName || agentId,
        entryScript,
        args,
        env,
      });

      res.json({
        success: true,
        agentId,
        pid: info.pid,
        status: info.status,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Failed to start agent:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 停止 Agent 进程
  app.post('/api/v1/agents/:agentId/stop', async (req: Request, res: Response) => {
    try {
      const agentId = Array.isArray(req.params.agentId) ? req.params.agentId[0] : req.params.agentId;
      const { signal } = req.body;

      const success = await processRegistry.stopAgentProcess(agentId, signal);

      if (!success) {
        return res.status(404).json({
          success: false,
          error: `Agent ${agentId} not found or not running`,
        });
      }

      res.json({
        success: true,
        agentId,
        message: `Agent ${agentId} stopped`,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Failed to stop agent:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Agent 统计
  app.get('/api/v1/agents/stats', async (req: Request, res: Response) => {
    try {
      const stats = processRegistry.getStats();
      res.json({
        success: true,
        stats,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Failed to get stats:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  log.info('Agent management routes registered');
}

export default registerAgentManagementRoutes;
