import express from 'express';
import fs from 'fs';
import path from 'path';
import { FINGER_PATHS, ensureDir } from '../../core/finger-paths.js';
import { Agent, AgentConfig } from '../agent.js';
import { HeartbeatMonitor } from '../core/heartbeat-broker.js';

export interface AgentDaemonConfig {
  agentId: string;
  agentName: string;
  mode: 'auto' | 'manual';
  systemPrompt?: string;
  allowedTools?: string[];
  fingerDaemonUrl: string;
  port: number;
  cwd?: string;
}

export interface TaskMessage {
  taskId?: string;
  content?: string;
  task?: string;
  text?: string;
  files?: Array<{ path?: string; image?: string }>;
}

const AGENT_PID_DIR = FINGER_PATHS.runtime.agentsDir;

function getPidFile(agentId: string): string {
  return path.join(AGENT_PID_DIR, `${agentId}.pid`);
}

export class AgentDaemon {
  private config: AgentDaemonConfig;
  private agent: Agent;
  private app = express();
  private server?: ReturnType<typeof this.app.listen>;
  private isRunning = false;
  private heartbeatMonitor: HeartbeatMonitor;

  constructor(config: AgentDaemonConfig) {
    this.config = config;

    const agentConfig: AgentConfig = {
      id: config.agentId,
      name: config.agentName,
      mode: config.mode,
      provider: 'iflow',
      systemPrompt: config.systemPrompt,
      allowedTools: config.allowedTools,
      cwd: config.cwd,
    };

    this.agent = new Agent(agentConfig);

    ensureDir(AGENT_PID_DIR);

    this.heartbeatMonitor = new HeartbeatMonitor();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log(`[AgentDaemon ${this.config.agentId}] Already running`);
      return;
    }

    const status = await this.agent.initialize();
    console.log(`[AgentDaemon ${this.config.agentId}] Connected, session: ${status.sessionId}`);

    this.setupHttpServer();

    await new Promise<void>((resolve) => {
      this.server = this.app.listen(this.config.port, () => {
        resolve();
      });
    });

    this.isRunning = true;

    if (process.pid) {
      fs.writeFileSync(getPidFile(this.config.agentId), process.pid.toString());
    }

    process.on('SIGTERM', async () => {
      await this.stop();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      await this.stop();
      process.exit(0);
    });

    // Start heartbeat monitor - self-destruct if master dies
    this.heartbeatMonitor.start(() => {
      console.error(`[AgentDaemon ${this.config.agentId}] Master heartbeat lost, initiating self-destruct`);
      this.stop().then(() => {
        process.exit(1);
      }).catch(() => {
        process.exit(1);
      });
    });
  }

  private setupHttpServer(): void {
    this.app.use(express.json());

    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'healthy',
        agentId: this.config.agentId,
        running: this.isRunning,
      });
    });

    this.app.get('/status', (_req, res) => {
      res.json({
        agentId: this.config.agentId,
        daemon: {
          port: this.config.port,
          running: this.isRunning,
        },
        agent: this.agent.getStatus(),
      });
    });

    this.app.post('/task', async (req, res) => {
      const message = req.body as TaskMessage;
      const taskContent = message.content ?? message.task ?? message.text;

      if (!taskContent) {
        res.status(400).json({ error: 'Missing content/task/text' });
        return;
      }

      const taskId = message.taskId ?? `${this.config.agentId}-${Date.now()}`;

      try {
        const result = await this.agent.execute(String(taskContent), undefined, message.files);
        res.json({ taskId, ...result });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        res.status(500).json({
          taskId,
          success: false,
          output: '',
          error: errorMessage,
        });
      }
    });

    this.app.post('/interrupt', async (_req, res) => {
      await this.agent.interrupt();
      res.json({ success: true });
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.heartbeatMonitor.stop();

    try {
      await Promise.race([
        this.agent.disconnect(),
        new Promise<void>((_, reject) => 
          setTimeout(() => reject(new Error('disconnect timeout')), 5000)
        ),
      ]);
    } catch (err) {
      console.error(`[AgentDaemon ${this.config.agentId}] Disconnect error:`, err);
    }

    if (this.server) {
     await new Promise<void>((resolve) => {
       this.server?.close(() => resolve());
     });
      this.server = undefined;
    }

    const pidFile = getPidFile(this.config.agentId);
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }

    this.isRunning = false;
  }
}
