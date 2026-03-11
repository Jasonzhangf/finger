# 超级命令解析与系统 Agent 隔离实现

**日期**: 2026-03-11
**状态**: 已完成核心实现，待测试

## 背景

用户要求实现超级命令消息系统和系统 agent 隔离：
1. 超级命令语法：`<####>...<####>` 块，包含 `<##@system##>` 和 `<##@agent##>` 标签
2. 系统agent独立隔离：cwd = `~/.finger/system/`，会话存储在独立路径
3. 渠道白名单鉴权 + 可选密码
4. agent 响应需要自报家门（SystemBot: 前缀）

## 实现架构

### 1. 超级命令解析器
- 文件: `src/server/middleware/super-command-parser.ts`
- 功能:
  - 解析 `<####>...<####>` 块
  - 提取 `<##@system[:<pwd=xxx>]##>` 和 `<##@agent##>` 标签
  - 超级命令块存在时忽略块外内容
  - 返回目标 agent 和有效内容

### 2. 系统命令认证
- 文件: `src/server/middleware/system-auth.ts`
- 配置: `~/.finger/config/system-commands.yaml`
- 功能:
  - 渠道白名单验证
  - 可选密码验证（SHA256）
  - 密码格式: `<##@system:<pwd=xxx>##>`

### 3. 渠道上下文管理器
- 文件: `src/orchestration/channel-context-manager.ts`
- 持久化: `~/.finger/config/channel-contexts.json`
- 功能:
  - 每个渠道维护当前 agent 上下文
  - 支持系统/业务模式切换
  - 后续消息路由到持久化的目标 agent

### 4. 系统 Agent
- 文件: `src/agents/finger-system-agent/index.ts`
- 配置: `~/.finger/runtime/agents/finger-system-agent/`
- 特性:
  - cwd = `~/.finger/system/`
  - 会话存储在 `~/.finger/system/sessions/`
  - 完全隔离，业务 agent 无法访问
  - 响应前缀: `SystemBot:`
  - 高权限，危险操作需用户授权

### 5. 会话管理器扩展
- 文件: `src/orchestration/session-manager.ts`
- 新增:
  - `SYSTEM_SESSIONS_DIR` = `~/.finger/system/sessions/`
  - `isSystemSession()` 检测方法
  - `createSystemSession()` 创建系统会话
  - `getOrCreateSystemSession()` 获取或创建系统会话
  - 系统会话使用独立存储路径

### 6. 消息路由更新
- 文件: `src/server/routes/message.ts`
- 流程:
  1. 解析超级命令
  2. 验证系统命令权限
  3. 更新渠道上下文
  4. 路由到目标 agent
  5. 响应包含 agent 信息和上下文切换状态

## 配置文件

### 系统命令配置 (`~/.finger/config/system-commands.yaml`)
```yaml
enabled: true
channelWhitelist:
  - webui
  - cli
  - qqbot
  - openclaw-qq
# passwordHash: ""
maxAttemptsPerMinute: 10
```

### 系统 Agent 运行时配置 (`~/.finger/runtime/agents/finger-system-agent/agent.json`)
- 提示词路径: `prompts/prompt.md`, `prompts/dev/orchestrator.md`
- 工具白名单: 基础编排工具 + 文件操作 + 命令执行

## 超级命令语法

```
<####><##@system##>系统命令内容<####>
<####><##@system:<pwd=密码>##>需要密码的系统命令<####>
<####><##@agent##>切换回业务 agent<####>
```

## 响应格式

系统 agent 响应包含：
- `agent`: `{ id: 'finger-system-agent', name: 'SystemBot', role: 'system', mode: 'system' }`
- `contextSwitch`: `{ from, to, previousMode }` (切换时)
- 响应内容以 `SystemBot:` 前缀开头

## 单元测试

- `tests/unit/server/middleware/super-command-parser.test.ts` - 13 个测试
- `tests/unit/server/middleware/system-auth.test.ts` - 3 个测试
- `tests/unit/orchestration/channel-context-manager.test.ts` - 3 个测试

## 提交

- Commit: `a75b505` - feat: implement super command parsing and system agent isolation
- 文件: 14 个文件，+842/-36 行

## 下一步

1. 本地测试系统 agent 功能
2. 验证超级命令切换流程
3. 测试会话隔离和持久化
4. 测试多渠道场景

## Tags

`super-command` `system-agent` `channel-context` `session-isolation` `authentication` `message-routing`
