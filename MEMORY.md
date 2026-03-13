# Finger 项目记忆

## 2026-03-11 双 Daemon 架构与标准化 Bridge 完成

### 已完成

1. **标准化 Channel Bridge 系统**
   - `src/bridges/types.ts` - 标准接口定义 (ChannelMessage, ChannelBridge, ChannelBridgeConfig)
   - `src/bridges/manager.ts` - 动态加载管理器 (支持异步 factory)
   - `src/bridges/openclaw-adapter.ts` - OpenClaw 插件适配器
   - OpenClaw 插件注册 channel 时自动注册为 BridgeModule

2. **CoreDaemon 集成**
   - 初始化 ChannelBridgeManager
   - 加载 `~/.finger/config/channels.json`
   - 消息处理闭环：channel-message → handleChannelMessage → hub.route → outputs
   - restart() 方法支持双 daemon 重启

3. **双 Daemon 架构**
   - `src/daemon/dual-daemon.ts` - 双进程互相监控
   - Daemon 1: port 9999/9998, Daemon 2: port 9997/9996
   - 5 秒健康检查间隔
   - 故障自动重启 (1 秒延迟)
   - CLI 命令:
     - `myfinger daemon start-dual`
     - `myfinger daemon stop-dual`
     - `myfinger daemon restart-dual`
     - `myfinger daemon status-dual --json`
     - `myfinger daemon enable-autostart` (launchd)
     - `myfinger daemon disable-autostart`

4. **配置文件**
   - `~/.finger/config/channels.json` - 渠道配置
   - `~/.finger/config/channels.json` 示例:
   ```json
   {
     "version": "v1",
     "channels": [
       {
         "id": "qqbot",
         "channelId": "qqbot",
         "enabled": true,
         "credentials": {
           "appId": "1903323793",
           "clientSecret": "woVyDF3dz72jCRRE",
           "accountId": "default"
         }
       }
     ]
   }
   ```

### 测试结果

- ✅ 双 daemon 启动成功 (PID 83083, 83104)
- ✅ Supervisor 运行 (PID 83013)
- ⏳ 故障恢复测试待进行
- ⏳ QQ 消息收发测试待进行

### 下一步

1. 测试故障恢复 (kill 一个 daemon 验证自动重启)
2. 测试真实 QQ 消息收发闭环
3. 启用开机自启

Tags: dual-daemon, bridge, openclaw, architecture, qqbot

## 2026-03-13 System Agent 规则与流程

### System Agent 核心规则

1. **只允许操作系统目录**（`~/.finger/system`）
   - 负责：系统配置、权限管理、插件管理、system MEMORY.md
   - **不得直接操作其他项目目录**

2. **跨项目操作必须分派**
   - 当用户请求操作非系统目录时，System Agent 必须检查项目是否存在
   - 若项目不存在：创建项目（目录+登记）
   - 然后 **assign 一个编排者 agent** 接管该项目
   - System Agent 仅负责分配与状态回报，实际操作由项目编排者完成

3. **交互切换模式**
   - 用户可以切换到新项目（交互对象变为项目编排者）
   - 或留在系统会话等待结果（System Agent 汇报）

4. **项目记忆管理**
   - 所有项目交互内容写入该项目目录的 `MEMORY.md`
   - 自动追加（用户输入 + 任务完成 summary）

### 系统目录结构

```
~/.finger/system/
├── MEMORY.md              # 系统记忆（System Agent 独占编辑）
├── prompts/
│   ├── system-prompt.md   # 系统管理员角色定义
│   └── system-dev.md      # 开发者约束说明
├── capability.md          # 系统能力说明文档
├── sessions/              # System Agent 会话存储
└── config/                # 系统配置（若有）
```

### 系统配置文件位置

- RouterConfiguration: `~/.finger/config/router-config.json`
- ChannelAuth: `~/.finger/config/config.json`（channelAuth 字段）
- Plugins: `~/.finger/config/plugins.json`（新建）
- 所有配置由 System Agent 管理

### Memory 记录规则

**自动记录条件**：
- `metadata.source` 是 `channel`/`api`/`webui`
- `metadata.role` 是 `user`
- `sourceAgentId` 不是其他 agent（排除 agent 派发）

**不记录场景**：
- Agent 派发的任务（agent→agent）
- System role 消息
- Mailbox 模式的消息（不进入 dispatch）

Tags: system-agent, rules, memory, capability, routing, permissions

## 2026-03-13 System Agent 实施细节

### 类型系统修复

**问题**: project_tool 使用非标准 `execute` 字段

**解决**: 改为 ToolRegistry 标准（`policy + handler`）

**文件修改**:
- `src/tools/internal/project-tool/project-tool.ts`
- `src/server/modules/agent-runtime/types.ts`（添加 `dispatchTaskToAgent` 可选依赖）

### 注册机制重构

**原则**: project_tool 只在运行时注册，不在 CLI 内部注册表

**原因**: 需要 AgentRuntimeDeps（sessionManager, dispatchTaskToAgent）

**实现**:
```typescript
// src/tools/internal/index.ts
export function registerProjectToolInRuntime(
  toolRegistry: ToolRegistry,
  getAgentRuntimeDeps: () => AgentRuntimeDeps
): void {
  registerProjectTool(toolRegistry, getAgentRuntimeDeps);
}
```

**调用点**: `src/runtime/default-tools.ts` 的 `registerDefaultRuntimeTools()`

### 验证状态

- ✅ 构建通过
- ✅ 类型检查通过
- ⏳ 运行时验证待进行（需要实际 channel/webui）

### 当前限制

`project_tool` 无法通过 `finger tool run --local` 测试：
- 原因: 只在运行时注册，CLI 内部注册表不包含
- 设计意图: 需要运行时环境才能验证

Tags: system-agent, project-tool, type-system, registration

## 2026-03-13 System Agent 运行时验证框架

### 测试框架设计

**测试文件**: `tests/integration/system-agent-runtime.test.ts`

**测试用例**:
1. Daemon 启动验证
2. System Agent 模块注册验证（包含 project_tool）
3. System Agent 目录结构验证
4. MEMORY 记录机制代码验证
5. project_tool 实现验证

**测试结果**: ✅ 5/5 tests passed

### 运行测试

```bash
npm run build:backend
npx vitest run tests/integration/system-agent-runtime.test.ts
```

### 验证覆盖

✅ **自动化验证**:
- Daemon 启动成功
- finger-system-agent 模块注册
- project_tool 工具加载
- System Agent 目录结构
- MEMORY 记录机制实现
- project_tool 实现文件存在

⏳ **手动验证**:
- 实际发送消息到 System Agent
- project_tool.create 创建项目
- MEMORY 自动追加用户输入和 summary
- 跨项目限制生效
- Agent 派发不记录

### 测试设计原则

1. 自动化优先
2. 代码层面验证
3. 运行时验证
4. 可扩展性

Tags: system-agent, runtime-verification, testing, integration-test, framework

## 2026-03-13 MessageHub/Agent 切换与命令前缀规则更新

- QQBot 回复前缀标注必须反映实际处理来源：
  - MessageHub 命令（<##help##>, <##@agent:list##>, <##@project:switch##> 等）统一标记为 `messagehub`
  - 只有真正进入 system agent / 普通 agent 的任务才标记为对应 agent
- `<##@system##>` 只是 MessageHub 处理的切换命令，不应显示为 system agent 回复
- System Agent capability 已增强：
  - project/session 默认切换逻辑（不指定 sessionId 切换最新）
  - `<##@project:switch@...##>` / `<##@agent:switch@...##>` / `<##@agent:list##>` / `<##@agent:new##>`
  - `/resume` 列表与 `/resume <sessionId>` 直接切换
- 规则：用户说“切换到某项目/会话”时，必须将该 project+session 设为当前默认会话，后续 `@agent` 默认使用该 session

Tags: messagehub, command-routing, system-agent, session-switch, qqbot, resume
