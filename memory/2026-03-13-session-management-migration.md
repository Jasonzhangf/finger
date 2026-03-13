# Session Management Migration to Agent Layer (2026-03-13)

## 变更概述

将 session 管理从 MessageHub 层迁移到 Agent 层，实现动态 session 切换能力。

## 架构变更

### 之前的架构
- `/resume` 指令由 MessageHub 的 `super-command-parser.ts` 解析
- Session 切换逻辑集中在路由层
- Agents 无法自主管理 session

### 新架构
- `/resume` 指令移除，由 Agents 通过工具调用处理
- 新增 `session.switch` 和 `session.list` 工具
- Session 管理下沉到 Agent 层
- MessageHub 专注于路由和 Agent 选择

## 代码变更

### 1. 移除 MessageHub 的 /resume 解析

**文件**: `src/server/middleware/super-command-parser.ts`
- 删除 `/resume` 相关的正则表达式匹配
- 移除 `session_list` 和 `session_switch` 类型（这些现在由 agent 工具处理）
- 更新注释说明 `/resume` 由 agent 层处理

### 2. 新增 Agent 层 Session 工具

**文件**: `src/server/modules/agent-runtime.ts`

#### session.switch 工具
```typescript
{
  name: 'session.switch',
  description: 'Switch to a different session within the current project',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string' },
      target_agent_id: { type: 'string' }  // 可选，仅 System Agent 可用
    },
    required: ['session_id']
  }
}
```

**权限规则**:
- 普通 agent: 只能切换自己的 session (`target_agent_id` 必须等于当前 agent)
- System Agent: 可以切换任何 agent 的 session

#### session.list 工具
```typescript
{
  name: 'session.list',
  description: 'List all sessions in the current project',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number' }  // 可选，限制返回数量
    }
  }
}
```

**返回格式**:
```typescript
{
  sessions: [{
    session_id: string,
    created_at: string,
    last_accessed_at: string,
    message_count: number
  }],
  total: number
}
```

### 3. 实现 <##@system:restart##> 命令

**文件**: `src/server/modules/channel-bridge-hub-route.ts`

```typescript
if (firstBlock.type === 'system' && firstBlock.content === 'restart') {
  await sendReply('系统重启指令已接收，正在安全重启 daemon...', 'messagehub');
  
  const daemon = (globalThis as any).__daemonInstance;
  if (daemon && typeof daemon.restart === 'function') {
    await daemon.restart();
  }
  
  return;
}
```

**特点**:
- 由 MessageHub 直接处理，不经过任何 agent
- 使用全局 daemon 实例调用 restart()
- 提供用户反馈消息

### 4. 更新 System Agent 能力文档

**文件**: `src/agents/finger-system-agent/capability.md`
- 版本升级到 v1.0.1
- 详细说明新的 session 管理工具使用方式
- 添加权限规则说明
- 添加 system:restart 命令文档
- 新增版本历史章节

## 设计决策

### 为什么迁移到 Agent 层？

1. **职责分离**: MessageHub 专注于路由，Session 管理是 Agent 的业务逻辑
2. **动态能力**: Agents 可以根据上下文自主决定是否切换 session
3. **权限控制**: System Agent 有跨 agent session 切换权限，普通 agent 只能操作自己的
4. **可扩展性**: 未来可以添加更多 agent 层的 session 操作工具

### 为什么保留 system:restart 在 MessageHub？

1. **系统级操作**: 重启 daemon 是系统级操作，不应该由任何 agent 处理
2. **安全性**: 避免 agent 恶意或错误地触发重启
3. **一致性**: 其他路由命令（如 `@system`, `@agent`, `@project`）都在 MessageHub 层

## 用户影响

### 用户使用方式

用户可以通过自然语言请求 session 操作：
- "切换到 session xyz"
- "显示所有会话"
- "把 agent abc 切换到 session xyz" (仅 System Agent)

Agent 会调用相应的工具执行操作。

### MessageHub 层命令（保留）

以下命令仍由 MessageHub 处理：
- `<##@system##>` - 切换到 System Agent
- `<##@system:pwd=xxx##>` - 切换到 System Agent（鉴权）
- `<##@system:restart##>` - 重启 daemon
- `<##@agent##>` - 切换到业务 orchestrator
- `<##@project:list##>` - 列出所有项目
- `<##@project:switch@/path##>` - 切换项目
- `<##@cmd:list##>` 或 `<##help##>` - 列出所有命令

## 兼容性

### 向后兼容

- 移除了 `/resume` 指令的直接支持
- 但用户可以通过自然语言请求实现相同功能
- Agent 会理解意图并调用相应工具

### 迁移路径

如果用户之前使用 `/resume`：
1. 直接说 "切换到 session xyz"
2. 或说 "显示所有会话" 然后选择
3. Agent 会处理这些自然语言请求

## 测试要点

1. **普通 agent session 切换**: 验证只能切换自己的 session
2. **System agent 跨 agent 切换**: 验证可以切换任何 agent 的 session
3. **Session list**: 验证返回正确的 session 信息
4. **system:restart**: 验证 daemon 安全重启
5. **权限边界**: 验证普通 agent 不能切换其他 agent 的 session

## 相关文件

- `src/server/middleware/super-command-parser.ts` - 移除 /resume 解析
- `src/server/modules/agent-runtime.ts` - 新增 session 工具
- `src/server/modules/channel-bridge-hub-route.ts` - 实现 system:restart
- `src/agents/finger-system-agent/capability.md` - 更新能力文档

## Commit 信息

- Commit: `33fce73`
- Message: "feat: Migrate /resume to agent layer, add session tools, implement system:restart"
- Date: 2026-03-13

Tags: finger, session-management, agent-tools, messagehub, architecture, capability-v1.0.1
