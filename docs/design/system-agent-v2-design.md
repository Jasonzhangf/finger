# System Agent V2 设计文档

> Epic: finger-247
> 创建时间: 2026-03-21
> 状态: 设计中

## 概述

System Agent V2 是 Finger 系统的核心调度代理，负责：
1. 用户请求的路由和派发
2. 系统级任务的执行
3. 记忆管理和用户画像维护
4. 多通道消息同步

## 一、Plan Mode 默认模式

### 1.1 参考 Codex Plan Mode

Codex 定义了 `ModeKind` 枚举：

```typescript
type ModeKind = "plan" | "default";
```

**Plan Mode 特性**：
- 禁止 `update_plan` 工具（模型必须先思考再执行）
- 允许 `request_user_input` 工具（需要用户确认）
- 流式输出时延迟 agent message start 直到非 plan text

### 1.2 System Agent 改进

```
用户请求
    │
    ▼
┌─────────────────────────────────────────────┐
│           请求类型判断                       │
├─────────────────────────────────────────────┤
│ 1. 简洁请求 (< 50字符, 无复杂目标)          │
│ 2. 项目操作 (路径在 project 目录)           │
│ 3. 系统操作 (路径在 ~/.finger/system)       │
│ 4. 复杂任务 (需要规划)                      │
└─────────────────────────────────────────────┘
    │
    ├─── 简洁请求 ──▶ 直接执行
    │
    ├─── 项目操作 ──▶ 检查项目是否存在
    │                    │
    │                    ├─ 存在 ──▶ 委派到 Project Agent
    │                    │
    │                    └─ 不存在 ──▶ 询问是否建立新项目
    │
    ├─── 系统操作 ──▶ System Agent 直接执行 (需授权)
    │
    └─── 复杂任务 ──▶ Plan Mode
                         │
                         ▼
                    生成计划
                         │
                         ▼
                    用户确认
                         │
                         ▼
                    按计划执行
```

### 1.3 实现要点

**请求分类逻辑**：

```typescript
interface RequestClassification {
  type: 'simple' | 'project' | 'system' | 'complex';
  targetPath?: string;
  projectId?: string;
  requiresPlanning: boolean;
}

function classifyRequest(input: string, context: SessionContext): RequestClassification {
  // 1. 检查是否包含路径
  const pathMatch = extractPath(input);
  if (pathMatch) {
    if (isSystemPath(pathMatch)) return { type: 'system', targetPath: pathMatch };
    if (isProjectPath(pathMatch)) return { type: 'project', targetPath: pathMatch };
  }

  // 2. 检查请求长度和复杂度
  if (input.length < 50 && !hasComplexGoal(input)) {
    return { type: 'simple' };
  }

  // 3. 默认为复杂任务
  return { type: 'complex', requiresPlanning: true };
}
```

**项目检查流程**：

```typescript
async function handleProjectRequest(input: string, path: string): Promise<void> {
  const registry = await loadRegistry();
  const projectId = projectIdFromPath(path);

  if (registry.agents[projectId]) {
    // 项目已存在，委派执行
    await dispatchToProjectAgent(projectId, input);
  } else {
    // 询问用户是否建立新项目
    await askUserToCreateProject(path);
  }
}
```

## 二、用户画像 & 记忆管理

### 2.1 文件结构

```
~/.finger/system/
├── USER.md           # 用户画像 (性格、喜好、关注点)
├── MEMORY.md         # 长期记忆 (重要事实、决策、教训)
├── CACHE.md          # 短期对话缓存 (当日)
├── SOUL.md           # 回答风格偏好
└── archive/
    └── cache-YYYY-MM-DD.md  # 归档的对话缓存
```

### 2.2 启动时加载

```typescript
async function loadUserProfile(): Promise<UserProfile> {
  const userMd = await readFile(USER_MD_PATH, 'utf-8').catch(() => '');
  const memoryMd = await readFile(MEMORY_MD_PATH, 'utf-8').catch(() => '');

  return {
    profile: parseUserMd(userMd),
    memories: parseMemoryMd(memoryMd),
  };
}

function injectProfileIntoPrompt(profile: UserProfile, basePrompt: string): string {
  const profileSection = `
## 用户画像

${formatProfileForPrompt(profile.profile)}

## 重要记忆

${formatMemoriesForPrompt(profile.memories)}
`;
  return basePrompt.replace('{{USER_PROFILE}}', profileSection);
}
```

### 2.3 对话结束时的记录

```typescript
async function compactAndRecord(session: Session, turn: Turn): Promise<void> {
  // 1. 压缩本轮对话到 CACHE.md
  const cacheEntry = summarizeTurn(turn);
  await appendFile(CACHE_MD_PATH, cacheEntry);

  // 2. 提取重要信息更新 MEMORY.md
  const importantFacts = extractImportantFacts(turn);
  if (importantFacts.length > 0) {
    await mergeIntoMemory(importantFacts);
  }

  // 3. 更新用户画像 USER.md
  const profileUpdates = analyzeUserBehavior(turn);
  if (profileUpdates) {
    await mergeIntoUserProfile(profileUpdates);
  }
}
```

### 2.4 每日回顾任务 (12:00 PM)

```typescript
const DAILY_REVIEW_CRON = '0 12 * * *';

async function dailyReview(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  // 1. 归档昨日 CACHE.md
  const cacheContent = await readFile(CACHE_MD_PATH, 'utf-8').catch(() => '');
  if (cacheContent.trim()) {
    await writeFile(`archive/cache-${yesterday}.md`, cacheContent);
  }

  // 2. 总结昨日内容写入新 CACHE.md 的"昨日回顾"
  const yesterdaySummary = await summarizeContent(cacheContent);
  await writeFile(CACHE_MD_PATH, `## 昨日回顾 (${yesterday})\n\n${yesterdaySummary}\n\n---\n\n`);

  // 3. 更新用户画像 (性格、喜好、关注点)
  const behaviorAnalysis = await analyzeWeeklyBehavior();
  await updateUserProfile(behaviorAnalysis);

  // 4. 调整 SOUL.md (回答风格偏好)
  const stylePreferences = await extractStylePreferences();
  await updateSoulMd(stylePreferences);
}
```

## 三、用户对话流程

### 3.1 默认流程

```
用户输入 ──▶ System Agent Session
                 │
                 ├── 用户输入 1
                 ├── System Agent 响应 1
                 ├── 派发任务给 Project Agent (type: dispatch)
                 ├── Project Agent 执行结果 (role: assistant, dispatch)
                 ├── 用户输入 2 (继续同一 session)
                 └── ...
```

### 3.2 Session History 结构

```typescript
interface SessionHistory {
  sessionId: string;
  messages: SessionMessage[];
  ledgerPointers: LedgerPointer[];
}

interface SessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  type?: 'dispatch' | 'reasoning' | 'tool_call' | 'tool_result';
  agentId?: string;
  metadata?: Record<string, unknown>;
}

interface LedgerPointer {
  label: string;  // 'main' | 'child:session-xxx'
  sessionId: string;
  agentId: string;
  memoryDir: string;
}
```

### 3.3 @agent 语法切换

```
用户输入: "@project-xxx 请检查 HEARTBEAT.md"
                    │
                    ▼
          直接路由到指定 Project Agent
          (不经过 System Agent)
```

**实现**：

```typescript
function parseAgentDirective(input: string): { agentId: string; task: string } | null {
  const match = input.match(/^@([a-zA-Z0-9_-]+)\s+(.+)$/s);
  if (!match) return null;

  return {
    agentId: match[1],
    task: match[2],
  };
}
```

## 四、派发任务返回处理

### 4.1 执行完成流程

```
Project Agent 执行完成
         │
         ▼
┌─────────────────────────────────────────────┐
│ 1. 结果写入子 session ledger                 │
│    context-ledger.jsonl {                   │
│      event_type: "turn_complete",           │
│      summary: "任务执行摘要...",             │
│      reasoning: [...],                      │
│      tool_trace: [...]                      │
│    }                                        │
│                                             │
│ 2. 触发 agent_runtime_dispatch 事件         │
│    (status: completed)                      │
│    - broadcast 到 WebSocket/QQBot           │
│    - 注入 ledger pointer 到主 session       │
│                                             │
│ 3. 主 session 接收 dispatch 结果            │
│    作为 assistant 消息                      │
└─────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│ System Agent 提示词明确说明:                │
│ "这是 Project Agent 执行结果，请根据结果:   │
│  - 继续派发新任务                           │
│  - 或反馈给用户执行结果"                    │
└─────────────────────────────────────────────┘
```

### 4.2 错误处理

```typescript
async function handleDispatchError(
  sessionId: string,
  error: Error,
  dispatch: DispatchRequest
): Promise<void> {
  // 1. 记录错误到 session history
  sessionManager.addMessage(sessionId, 'system',
    `[派发失败] ${error.message}`,
    { type: 'dispatch_error', agentId: dispatch.targetAgentId }
  );

  // 2. 指数回退重试 (最多 10 次)
  const retryCount = dispatch.retryCount ?? 0;
  if (retryCount < 10) {
    const delayMs = Math.min(1000 * Math.pow(2, retryCount), 60000);
    await sleep(delayMs);
    await retryDispatch(dispatch, retryCount + 1);
  } else {
    // 3. 全部失败后通知用户
    await notifyUser(sessionId,
      `任务派发失败 (重试 ${retryCount} 次): ${error.message}`
    );
  }
}
```

## 五、Heartbeat & Mailbox 反馈

### 5.1 邮箱结构

```
~/.finger/mailbox/{agentId}/inbox.jsonl

每条消息格式:
{
  "id": "msg-xxx",
  "title": "Heartbeat 任务完成通知",     // 标题
  "summary": "项目 A 检查完成，发现...",  // 缩写
  "detail": { ... },                      // 详情 (可选加载)
  "priority": 1,
  "status": "pending" | "read",
  "timestamp": "..."
}
```

### 5.2 定时检查流程

```typescript
async function tick(): Promise<void> {
  // 1. 派发心跳任务 (通过 mailbox 模式)
  await dispatchHeartbeatTasks();

  // 2. 检查未读邮箱
  const agents = await listAgents();
  for (const agent of agents) {
    if (agent.status !== 'idle' && agent.status !== 'completed') continue;

    const pending = heartbeatMailbox.listPending(agent.agentId);
    if (pending.length === 0) continue;

    // 3. 构建邮箱检查提示词 (只含 title + summary)
    const prompt = buildMailboxPrompt(pending);
    await dispatchDirect(agent.agentId, 'mailbox-check', prompt);
  }
}
```

### 5.3 邮箱提示词格式

```markdown
# Mailbox Check

你有待处理的系统消息：

1. [Heartbeat] 项目 A 检查完成 (msg-001)
   摘要: 发现 HEARTBEAT.md 有未完成任务

2. [Task] 用户请求处理完成 (msg-002)
   摘要: 文件已创建，等待用户确认

请逐条处理，完成后调用 report-task-completion。
如需查看详情，请查阅对应 mailbox 文件。
```

## 六、任务清单

### P0 - 必须立即修复

| Task ID | 标题 | 说明 |
|---------|------|------|
| finger-247.1 | 设计文档落盘 | 本文档 |
| finger-247.2 | Memory 质量保证 | 修复 Memory 记录无意义内容问题 |
| finger-247.3 | Session 历史完整性 | 确保所有输入输出进入 session history |
| finger-247.4 | 派发任务结果反馈 | 确保子 agent 结果正确注入主 session |

### P1 - 近期优化

| Task ID | 标题 | 说明 |
|---------|------|------|
| finger-247.5 | Plan Mode 集成 | 实现请求分类和简洁请求直接执行 |
| finger-247.6 | 每日回顾任务 | 实现 12:00 PM 定时归档和总结 |

### P2 - 后续优化

| Task ID | 标题 | 说明 |
|---------|------|------|
| finger-247.7 | @agent 语法支持 | 解析 @agent 前缀并直接路由 |
| finger-247.8 | 邮箱分层查看 | 实现 title/summary/detail 三层结构 |

## 七、依赖关系

```
finger-247.1 (设计文档)
    │
    ├──▶ finger-247.2 (Memory 质量保证)
    │        │
    │        └──▶ finger-247.5 (Plan Mode)
    │        │
    │        └──▶ finger-247.6 (每日回顾)
    │
    ├──▶ finger-247.3 (Session 完整性)
    │        │
    │        └──▶ finger-247.5 (Plan Mode)
    │
    └──▶ finger-247.4 (派发反馈)
```

## 八、验收标准

### finger-247.2 Memory 质量保证
- [ ] USER.md 启动时正确加载到 system prompt
- [ ] 对话结束时 CACHE.md 记录有意义的内容摘要
- [ ] MEMORY.md 记录重要事实而非 "System entry"

### finger-247.3 Session 历史完整性
- [ ] 用户输入正确进入 session history
- [ ] Agent 响应正确进入 session history
- [ ] dispatch 失败也记录到 session history
- [ ] 推理重试时能正确读取历史上下文

### finger-247.4 派发任务结果反馈
- [ ] 子 agent 执行结果注入主 session
- [ ] System Agent 提示词明确说明如何处理 dispatch 结果
- [ ] 用户能看到派发任务的进度更新

### finger-247.5 Plan Mode 集成
- [ ] 简洁请求直接执行
- [ ] 项目操作自动委派
- [ ] 复杂任务生成计划并等待确认

### finger-247.6 每日回顾任务
- [ ] 12:00 PM 自动触发归档
- [ ] CACHE.md 正确归档
- [ ] USER.md 正确更新用户画像

---

*最后更新: 2026-03-21 15:19 +08:00*
