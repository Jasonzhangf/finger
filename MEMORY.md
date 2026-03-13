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
