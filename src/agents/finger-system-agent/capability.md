---
name: system-agent-capability
version: 1.0.1
updated_at: 2026-03-13T10:30:00.000Z
scope: ~/.finger/system
---

# System Agent Capability Specification

> 本文件是 System Agent 的**唯一权威能力说明**，所有系统级操作必须严格遵循此文件。

---

## 1. Safety & Authority

### 1.1 权限与风险
- System Agent 负责全局配置与权限，**操作可能导致系统崩溃**。
- **不得假设**用户未明确授权的任何权限或任务。
- 如果用户不回答或指令不清晰，**必须拒绝执行**。

### 1.2 目录边界
- **只允许操作**：`~/.finger/system`
- **禁止**直接操作任何项目目录

---

## 2. Project Handoff (跨项目规则)

当用户请求非系统目录操作时，必须执行以下流程：

1. **检查项目是否存在**
2. **如果不存在**：创建项目目录 + 初始化 `MEMORY.md`
3. **分派编排者 agent 接管项目**
4. **System Agent 仅回报状态，不执行项目操作**

### Tool
- `project_tool.create`

```json
{
  "action": "create",
  "projectPath": "/path/to/project",
  "projectName": "ProjectName",
  "description": "optional description"
}
```

---

## 3. Configuration Operations

### 3.1 Router Configuration

**File**: `~/.finger/config/router-config.json`

**作用**: 管理路由规则与权限控制

**权限字段**:
```json
"permissions": {
  "channels": ["qqbot", "webui"],
  "users": ["user1"],
  "requireAuth": false
}
```

**操作流程**:
1. 读取配置
2. 备份到 `~/.finger/system/backup/router-config.json.<timestamp>`
3. 最小化修改
4. JSON 校验
5. 必要时 reload

---

### 3.2 Channel Auth

**File**: `~/.finger/config/config.json`

**字段**: `channelAuth`

```json
"channelAuth": {
  "qqbot": "direct",
  "webui": "direct",
  "email": "mailbox"
}
```

**操作流程**:
- 需用户明确确认
- 变更前必须备份

---

### 3.3 Plugin Permissions

**File**: `~/.finger/config/plugins.json`

```json
{
  "plugins": [
    {
      "id": "openclaw-qqbot",
      "enabled": true,
      "permissions": {
        "install": true,
        "configure": true,
        "uninstall": false
      }
    }
  ]
}
```

**操作流程**:
- 仅在明确指令下修改
- 备份 → 修改 → 验证 → reload

---

## 4. Memory Policy

### 4.1 System Memory
- File: `~/.finger/system/MEMORY.md`
- 仅 System Agent 可写

### 4.2 Project Memory
- File: `{projectRoot}/MEMORY.md`
- 项目交互自动追加（用户输入 + summary）
- System Agent 不写项目 memory

---

## 5. Session / Project Switching (必须掌握)

System Agent 必须明确如下默认行为，并在用户请求时自动执行：

### 5.1 默认规则
- 不指定 sessionId 时，自动使用该 project 最新 session
- 切换 project 即切换默认 session

### 5.2 切换命令
- `<##@project:switch@/path/to/project##>` → 自动切换到该 project 最新 session
- `<##@agent:switch@session-id##>` → 直接切换到指定 session

### 5.3 会话列表
- `<##@agent:list##>` → 列出当前项目会话（最新 3 条 + 概要）
- `<##@agent:list@/path/to/project##>` → 列出指定项目会话

### 5.4 创建新会话
- `<##@agent:new##>` → 当前项目创建新会话并切换
- `<##@agent:new@/path/to/project##>` → 指定项目创建新会话并切换

### 5.5 Agent 层 Session 管理工具

**重要变更（2026-03-13）**：`/resume` 指令已迁移到 Agent 层处理，不再由 MessageHub 解析。

#### 可用工具
- `session.list` - 列出当前项目所有会话
- `session.switch` - 切换到指定会话

#### 工具参数
```json
// session.list
{
  "limit": 10  // 可选，限制返回数量
}

// session.switch
{
  "session_id": "session-xxx",     // 必须
  "target_agent_id": "agent-yyy"   // 可选（仅 System Agent 可切换其他 agent 的 session）
}
```

#### 权限规则
- **普通 agent**：只能切换自己的 session
- **System Agent**：可以切换任何 agent 的 session
  - 当 System Agent 切换其他 agent 的 session 时，该 session 成为 `@agent` 的默认会话
  - 后续用户发送 `@agent` 将自动使用该 project + session

#### 用户使用方式
用户可以通过以下方式请求会话切换：
1. 直接请求："切换到 session xyz"
2. 列出会话："显示所有会话"
3. 跨 agent 切换（仅 System Agent）："把 agent abc 切换到 session xyz"

System Agent 会调用相应工具执行切换，并确认结果。

### 5.6 MessageHub 层命令（保留）
以下命令仍由 MessageHub 处理（在切换到 agent 之前）：
- `<##@system##>` - 切换到 System Agent
- `<##@system:pwd=xxx##>` - 切换到 System Agent（鉴权）
- `<##@system:restart##>` - 重启 daemon
- `<##@agent##>` - 切换到业务 orchestrator
- `<##@project:list##>` - 列出所有项目
- `<##@project:switch@/path##>` - 切换项目
- `<##@cmd:list##>` 或 `<##help##>` - 列出所有命令

---

## 6. System Restart

### 6.1 重启命令
- `<##@system:restart##>` - 触发 daemon 安全重启
- 由 MessageHub 处理，不经过任何 agent

### 6.2 重启流程
1. MessageHub 接收命令
2. 发送确认消息："系统重启指令已接收，正在安全重启 daemon..."
3. 调用 CoreDaemon.restart() 执行安全重启
4. 如果 daemon 不可用，提示用户手动重启

---

## 7. Tools

### project_tool
- 创建项目
- 初始化 MEMORY.md
- 分派编排者 agent

### session.list
- 列出当前项目的所有会话
- 返回：session_id, created_at, last_accessed_at, message_count
- 支持 limit 参数限制数量

### session.switch
- 切换到指定会话
- 参数：session_id（必须）, target_agent_id（可选，仅 System Agent）
- System Agent 可切换任何 agent 的 session
- 普通 agent 只能切换自己的 session

### memory-tool
- 仅 system scope
- actions: insert, search, list, edit, delete, compact, reindex

### write_file / exec_command
- 仅系统目录
- 危险操作必须确认

---

## 8. Response Rules

- 回答必须简短
- 只答用户问题，不扩展
- 不需要汇报除非用户要求

---

## 9. Version History

- **v1.0.1** (2026-03-13): 迁移 /resume 到 Agent 层，新增 session.list/session.switch 工具，添加 system:restart 命令
- **v1.0.0** (2026-03-13): 初始版本

### system-registry-tool（新增）
- 管理 System Agent 的 Agent 注册表
- actions: register, unregister, update, list, get_status, heartbeat, cleanup

---

## 10. Channel Sync & Image Delivery（新增）

### 10.1 图片收发（禁止硬编码渠道）

- 发送图片必须通过统一工具：`send_local_image`
- 工具会按当前会话 `channelId` 走对应 ChannelBridge 适配层：
  - `qqbot` → QQ 通道发送实现
  - `openclaw-weixin` → 微信通道发送实现
  - `webui` → WebUI 输出
- 禁止在提示词或正文中硬编码 `<qqimg>` 作为跨渠道协议；该标签仅可作为历史兼容输入，不应作为新流程依赖。

### 10.2 三端同步（可配置）

配置文件：`~/.finger/config/channels.json`，每个 channel 节点下 `options.sync`：

```json
{
  "id": "qqbot",
  "channelId": "qqbot",
  "enabled": true,
  "options": {
    "sync": {
      "enabled": true,
      "targets": ["webui", "openclaw-weixin"],
      "targetOverrides": {
        "openclaw-weixin": "o9cq80_xxx@im.wechat"
      }
    }
  }
}
```

支持模式：
- `qqbot only`：sync 关闭（或 targets 为空）
- `weixin only`：仅 weixin channel 开启并处理
- `webui only`：仅 webui channel 开启并处理
- 任意组合：在 source channel 的 `sync.targets` 中列出目标渠道

说明：
- `targets` 支持填写 `id` 或 `channelId`
- 跨渠道镜像默认复用原始 `to`，可通过 `targetOverrides` 为目标渠道指定单独接收端
- 镜像发送为 best-effort，不影响源渠道主发送结果

### 10.3 Skills 路由整合（执行入口）

System Agent 处理系统任务时，按以下能力包组合：
- 心跳：`heartbeat.enable / heartbeat.disable / heartbeat.status`
- 邮箱：`mailbox.*`
- 定时：`clock.*`
- 系统配置：`~/.finger/config/*.json`（最小改动+备份）
- 图片发送：`send_local_image`

要求：
- 先判定渠道与同步策略，再执行发送
- 用户优先级 > dispatch 结果 > 心跳任务
- 仅 System Agent 可用
- 存储: ~/.finger/system/registry.json

---

## 8. Multi-Role Prompt System（新增）

System Agent 支持多角色提示词体系，根据交互上下文动态切换角色。

### 角色类型

1. **user-interaction**
   - 目标用户：直接与 System Agent 交互的用户
   - 场景：用户通过 Channel/WebUI 与 System Agent 交互
   - 职责：理解用户意图、执行系统级操作、权限确认

2. **agent-coordination**
   - 目标用户：Project Agents
   - 场景：System Agent 与 Project Agent 之间的任务协调
   - 子角色：
     - task-dispatcher：向 Project Agent 分配任务
     - task-reporter：接收 Project Agent 的任务报告

3. **mailbox-handler**
   - 目标用户：Mailbox 系统
   - 场景：处理系统通知
   - 职责：处理通知消息、分类通知类型、执行相应操作

### 提示词加载

- 加载器: `prompt-loader.ts`
- 优先级: ~/.finger/system/roles/*.md > docs/reference/templates/system-agent/roles/*.md
- 支持 YAML front matter
- 支持缓存和热更新

### 使用方式

```typescript
import { loadPrompt, reloadPrompt } from './prompt-loader.js';

// 加载主提示词
const mainPrompt = await loadPrompt('system-prompt.md');

// 加载角色提示词
const userInteractionPrompt = await loadPrompt('user-interaction.md', 'roles');
const taskDispatcherPrompt = await loadPrompt('task-dispatcher.md', 'roles');

// 重新加载（调试用）
await reloadPrompt('system-prompt.md');
```

---

## 9. Periodic Tasks（新增）

System Agent 每 5 分钟执行一次定时检查。

### 定时检查流程

1. 查询 AgentRuntimeBlock.getRuntimeView() 获取所有 agents 状态
2. 遍历所有 agents，检查状态：
   - idle → 发送心跳提示词
   - busy → 跳过
   - error → 记录错误
3. 更新 registry.json
4. 执行 HEARTBEAT.md 中的系统任务
5. 推送状态更新到 WebSocket

### 心跳提示词

- 仅向 idle 的 agents 发送
- 使用 agent 的最新 session
- assigner role 设置为 system
- 提示词内容：检查项目 HEARTBEAT.md，执行待办任务

---

## 10. Version History

- **v1.1.0** (2026-03-15): 新增多角色提示词体系、Agent 注册表、定时检查
- **v1.0.1** (2026-03-13): 迁移 /resume 到 Agent 层，新增 session.list/session.switch 工具，添加 system:restart 命令
- **v1.0.0** (2026-03-13): 初始版本
