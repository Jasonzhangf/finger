# MessageHub 指令集 + 双层鉴权 + 会话管理设计文档

## 背景

当前系统缺少统一的命令管理和会话切换机制。用户需要通过手动操作切换 agent 和 session，缺少简单的命令接口。

## 目标

1. 提供统一的超级命令语法，支持 Agent/Project/Session 管理
2. 实现双层鉴权：通道层（控制消息能否直达 agent）和 System Agent 层
3. 明确核心概念：Project = 工作目录，Session = 基于 Project 的对话上下文，Agent = 活跃的对话智能体

## 核心概念关系

```
Project (工作目录)
  ↓ 包含多个
Session (对话上下文)
  ↓ attach
Agent (活跃的对话智能体)

示例：
Project: /Volumes/extension/code/finger
  ├─ Session-1 (agent: orchestrator, 15 条消息)
  ├─ Session-2 (agent: system, 8 条消息)
  └─ Session-3 (agent: orchestrator, 23 条消息)

Project: ~/.finger (系统目录)
  ├─ Session-sys-1 (agent: system, 5 条消息)
  └─ Session-sys-2 (agent: system, 12 条消息)
```

**关键点**：
- Session 数据按 Project 物理隔离存储
- Agent 必须 attach 到 Session 才能工作
- 切换 Agent = 切换 Project + Session

## 命令语法设计

### 基础语法

扩展现有的 `<##@...##>` 超级命令语法：

```
<##@cmd:list##>                → 列出所有可用命令
<##@agent:list##>               → 列出当前 project 的所有 session
<##@agent:list@/path/to/proj##> → 列出指定 project 的所有 session
<##@agent:new##>                → 在当前 project 创建新 session 并切换
<##@agent:new@/path/to/proj##>  → 在指定 project 创建新 session 并切换
<##@agent:switch@session-id##> → 切换到指定 session（自动识别 project）
<##@agent:delete@session-id##> → 删除指定 session
<##@system##>                   → 切换到 system agent (project=~/.finger, 最新 session)
<##@system:pwd=xxx##>           → 切换到 system agent (鉴权)
<##@project:list##>             → 列出所有有 session 的 project
<##@project:switch@/path##>     → 切换 project（使用该 project 最新 session）
```

### 命令响应示例

#### `<##@cmd:list##>`

```
可用命令：
  <##@system##>                    - 切换到系统代理（project=~/.finger，最新 session）
  <##@agent:list##>                 - 列出当前项目的会话
  <##@agent:list@/path/to/proj##>   - 列出指定项目的会话
  <##@agent:new##>                  - 在当前项目创建新会话
  <##@agent:new@/path/to/proj##>    - 在指定项目创建新会话
  <##@agent:switch@session-id##>   - 切换到指定会话
  <##@agent:delete@session-id##>   - 删除会话
  <##@project:list##>              - 列出所有项目
  <##@project:switch@/path##>      - 切换项目路径（使用最新 session）
  <##@cmd:list##>                  - 显示此帮助
```

#### `<##@agent:list##>`

```
项目：/Volumes/extension/code/finger

会话列表：

  1. [session-123] [当前] 2026-03-13 08:45:30 - "天气查询任务" (15 条消息)
  2. [session-124] 2026-03-13 07:30:15 - "代码重构" (12 条消息)
  3. [session-125] 2026-03-12 16:20:45 - "文档编写" (8 条消息)

使用 <##@agent:switch@session-id##> 切换会话
```

#### `<##@agent:switch@session-123##>`

```
✓ 已切换到会话：[session-123]
项目路径：/Volumes/extension/code/finger

加载会话历史... (15 条消息)
继续对话...
```

#### `<##@system##>`

```
✓ 已切换到 System Agent
系统目录：/Users/fanzhang/.finger

最近 3 条 System Agent 会话：
  1. [session-sys-1] 2026-03-13 09:15:00 - "查询系统状态..."
  2. [session-sys-2] 2026-03-12 14:20:30 - "配置检查..."
  3. [session-sys-3] 2026-03-10 10:45:15 - "日志分析..."

已自动切换到最新会话：[session-sys-1]

输入系统命令或问题...
```

#### `<##@project:list##>`

```
所有项目（按最近访问时间排序）：

  1. /Volumes/extension/code/finger (34 个会话)
  2. /Users/fanzhang/Documents/github/routecodex (12 个会话)
  3. /Users/fanzhang/code/webauto (5 个会话)

使用 <##@project:switch@/path##> 切换项目（自动使用最新 session）
```

## 双层鉴权体系

### 第一层：通道鉴权（Channel Authorization）

**配置**：`~/.finger/config/config.json`

```json
{
  "channelAuth": {
    "enabled": true,
    "defaultPolicy": "direct",
    "channels": [
      { "id": "webui", "type": "direct", "priority": 10 },
      { "id": "qqbot", "type": "direct", "priority": 20 },
      { "id": "cli", "type": "direct", "priority": 5 },
      { "id": "feishu", "type": "mailbox", "priority": 30 }
    ]
  }
}
```

**策略说明**：
- `type: "direct"` - 消息可直接路由到 agent（实时响应）
- `type: "mailbox"` - 消息必须进 mailbox 队列（异步处理）
- `defaultPolicy` - 未配置通道的默认策略
- qqbot 必须显式配置为 direct 才能进入 agent 模式

**路由决策**：
```
收到消息
  ↓
解析超级命令
  ├─ 是超级命令 → 直接处理命令
  └─ 非超级命令 → 检查通道策略
      ├─ type === "direct" → 通过 MessageHub 路由到 agent
      └─ type === "mailbox" → 进入 mailbox 队列
```

### 第二层：System Agent 鉴权

**配置**：`~/.finger/config/config.json`

```json
{
  "systemAuth": {
    "enabled": true,
    "password": null
  }
}
```

**策略说明**：
- `enabled: false` - 禁用 system agent
- `password: null` - 无密码要求（开发模式）
- `password: "sha256:hash"` - 要求密码验证

**鉴权流程**：
```
检测到 <##@system##> 命令
  ↓
检查 systemAuth.enabled
  ├─ false → 返回 "System agent is disabled"
  └─ true → 检查 password
      ├─ null → 允许进入
      └─ 有值 → 验证 <##@system:pwd=xxx##> 的 SHA256
          ├─ 匹配 → 允许进入
          └─ 不匹配 → 返回 "Invalid password"
```

## 默认策略

### 默认项目策略

1. **配置优先**：`defaults.projectPath`（如 `~/.finger`）
2. **最近一次项目**：`defaults.useLastProject = true` 时，从 sessionManager 最近访问记录推断
3. **默认**：`~/.finger`

**配置**：`~/.finger/config/config.json`

```json
{
  "defaults": {
    "projectPath": "~/.finger",
    "useLastProject": true
  }
}
```

### 默认会话策略

- 未指定 session 时，使用该项目的最新 session（按 lastAccessedAt 排序）
- 如果该项目没有 session，则创建新 session

## 模块设计

### 1. 配置加载模块

**文件**：`src/core/config/channel-config.ts`

```typescript
export interface ChannelAuthConfig {
  id: string;
  type: 'direct' | 'mailbox';
  priority: number;
}

export interface ChannelAuthSection {
  enabled: boolean;
  defaultPolicy: 'direct' | 'mailbox';
  channels: ChannelAuthConfig[];
}

export interface SystemAuthConfig {
  enabled: boolean;
  password: string | null;
}

export interface DefaultsConfig {
  projectPath?: string;
  useLastProject?: boolean;
}

export interface FingerConfig {
  kernel: { ... };
  channelAuth: ChannelAuthSection;
  systemAuth: SystemAuthConfig;
  defaults?: DefaultsConfig;
}

export async function loadFingerConfig(): Promise<FingerConfig>;

export function getChannelAuth(config: FingerConfig, channelId: string): 'direct' | 'mailbox';
```

### 2. 命令处理模块

**文件**：`src/server/modules/messagehub-command-handler.ts`

```typescript
export async function handleCmdList(): Promise<string>;
export async function handleAgentList(sessionManager: SessionManager, projectPath?: string): Promise<string>;
export async function handleAgentNew(sessionManager: SessionManager, projectPath?: string): Promise<string>;
export async function handleAgentSwitch(sessionManager: SessionManager, sessionId: string): Promise<string>;
export async function handleAgentDelete(sessionManager: SessionManager, sessionId: string): Promise<string>;
export async function handleSystemCommand(sessionManager: SessionManager): Promise<string>;
export async function handleProjectList(sessionManager: SessionManager): Promise<string>;
export async function handleProjectSwitch(sessionManager: SessionManager, projectPath: string): Promise<string>;
```

### 3. 扩展超级命令解析器

**文件**：`src/server/middleware/super-command-parser.ts`

```typescript
export interface SuperCommandBlock {
  type:
    | 'system'
    | 'agent_list'
    | 'agent_new'
    | 'agent_switch'
    | 'agent_delete'
    | 'project_list'
    | 'project_switch'
    | 'cmd_list'
    | 'invalid';
  content: string;
  path?: string;
  sessionId?: string;
  password?: string;
}
```

### 4. 消息路由集成

**文件**：`src/server/routes/message.ts`

在 super_command 处理分支中集成新的命令处理函数。

## 测试验收

### 单元测试

1. **配置加载测试**：验证配置解析、通道策略解析、默认项目解析
2. **命令解析测试**：验证各种命令语法的正确解析
3. **命令处理测试**：验证各种命令的响应格式

### 集成测试

1. **通道路由测试**：验证 direct/mailbox 模式的正确路由
2. **鉴权测试**：验证 system agent 鉴权流程
3. **会话管理测试**：验证 session 创建、切换、删除

### E2E 测试

1. **WebUI 场景**：通过 WebUI 发送命令，验证响应
2. **QQ Bot 场景**：通过 QQ 发送命令，验证响应
3. **多项目场景**：跨项目切换 session

## 边界与错误处理

1. **Session 不存在**：返回明确的错误提示
2. **项目路径无效**：自动 resolve 或返回错误
3. **鉴权失败**：返回 403 或错误提示
4. **删除当前 session**：自动切换到同项目最新 session
5. **System Agent 禁用**：返回禁用提示
6. **未配置通道**：使用 defaultPolicy

## 关键假设

1. **Project = 工作目录**：Session 按 Project 物理隔离
2. **Agent 必须 attach 到 Session**：切换 Agent = 切换 Project + Session
3. **通道鉴权**：qqbot 必须显式配置为 direct 才能进入 agent 模式
4. **超级命令优先**：超级命令始终直接处理，不受通道策略影响
5. **System Project**：固定为 `~/.finger`
6. **密码格式**：使用 SHA256 哈希，格式为 `"sha256:hash"`
