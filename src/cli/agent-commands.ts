/**
 * Agent CLI Commands - Message Hub wrappers
 * 
 * 所有命令通过 Message Hub (9999) 发送消息，符合当前 daemon 默认端口规范。
 * CLI 是纯粹客户端：发送请求后立即退出（除非 --watch）。
 */

const MESSAGE_HUB_URL = process.env.FINGER_HUB_URL || 'http://localhost:9999';
const WEBSOCKET_URL = process.env.FINGER_WS_URL || 'ws://localhost:9998';

export interface CommandOptions {
  sessionId?: string;
  blocking?: boolean;
  watch?: boolean;
  json?: boolean;
}

/**
 * 生成 callbackId 用于追踪非阻塞请求
 */
function generateCallbackId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `cli-${timestamp}-${random}`;
}

/**
 * 发送消息到 Message Hub
 */
async function sendMessageToHub(
  target: string,
  messageType: string,
  payload: unknown,
  options: { blocking?: boolean; sender?: string; callbackId?: string } = {}
): Promise<{ messageId: string; status: string; result?: unknown; error?: string }> {
  const res = await fetch(`${MESSAGE_HUB_URL}/api/v1/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target,
      message: { type: messageType, ...(payload as Record<string, unknown>) },
      blocking: options.blocking || false,
      sender: options.sender || 'cli',
      callbackId: options.callbackId,
    }),
  });

  if (!res.ok) {
    throw new Error(`Message Hub error: ${res.statusText}`);
  }

  return res.json();
}

/**
 * 格式化输出
 */
function formatOutput(result: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('[CLI] Result:', result);
  }
}

/**
 * 语义理解命令
 * CLI: finger understand <input>
 * Target: understanding-agent
 */
export async function understandCommand(input: string, options: { sessionId?: string; json?: boolean } = {}): Promise<void> {
  const callbackId = generateCallbackId();
  
  const result = await sendMessageToHub('understanding-agent', 'UNDERSTAND', {
    input,
    sessionId: options.sessionId,
  }, { callbackId });

  formatOutput({ ...result, callbackId }, options.json || false);
}

/**
 * 路由决策命令
 * CLI: finger route --intent <json>
 * Target: router-agent
 */
export async function routeCommand(intentAnalysis: string, options: { sessionId?: string; json?: boolean } = {}): Promise<void> {
  const callbackId = generateCallbackId();
  
  const result = await sendMessageToHub('router-agent', 'ROUTE', {
    intentAnalysis: JSON.parse(intentAnalysis),
    sessionId: options.sessionId,
  }, { callbackId });

  formatOutput({ ...result, callbackId }, options.json || false);
}

/**
 * 任务规划命令
 * CLI: finger plan <task>
 * Target: planner-agent
 */
export async function planCommand(task: string, options: { sessionId?: string; json?: boolean } = {}): Promise<void> {
  const callbackId = generateCallbackId();
  
  const result = await sendMessageToHub('planner-agent', 'PLAN', {
    task,
    sessionId: options.sessionId,
  }, { callbackId });

  formatOutput({ ...result, callbackId }, options.json || false);
}

/**
 * 任务执行命令
 * CLI: finger execute --task <t>
 * Target: executor-agent
 */
export async function executeCommand(task: string, options: { agent?: string; blocking?: boolean; sessionId?: string; json?: boolean } = {}): Promise<void> {
  const callbackId = generateCallbackId();
  
  const result = await sendMessageToHub(options.agent || 'executor-agent', 'EXECUTE', {
    task,
    sessionId: options.sessionId,
  }, { 
    blocking: options.blocking,
    callbackId: options.blocking ? undefined : callbackId,
  });

  formatOutput({ ...result, callbackId }, options.json || false);
}

/**
 * 质量审查命令
 * CLI: finger review --proposal <json>
 * Target: reviewer-agent
 */
export interface ReviewOptions {
  json?: boolean;
}

export async function reviewCommand(proposal: string, options: ReviewOptions = {}): Promise<void> {
  const callbackId = generateCallbackId();
  
  const result = await sendMessageToHub('reviewer-agent', 'REVIEW', {
    proposal: JSON.parse(proposal),
  }, { callbackId });

  formatOutput({ ...result, callbackId }, options.json || false);
}

/**
 * 编排协调命令
 * CLI: finger orchestrate <task>
 * Target: orchestrator
 */
export async function orchestrateCommand(task: string, options: { sessionId?: string; watch?: boolean; json?: boolean } = {}): Promise<void> {
  const callbackId = generateCallbackId();
  
  const result = await sendMessageToHub('orchestrator', 'ORCHESTRATE', {
    task,
    sessionId: options.sessionId,
  }, { callbackId });

  const workflowId = (result.result as { workflowId?: string })?.workflowId;
  
  formatOutput({ ...result, callbackId, workflowId }, options.json || false);
  
  if (options.watch && workflowId) {
    console.log('[CLI] Watch mode enabled.');
    console.log(`[CLI] WebSocket: ${WEBSOCKET_URL}`);
    console.log(`[CLI] Subscribe: { "type": "subscribe", "workflowId": "${workflowId}" }`);
    console.log(`[CLI] Or run: finger events ${workflowId} --watch`);
  }
}
