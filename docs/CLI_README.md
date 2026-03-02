# Finger CLI 使用指南

## 安装

```bash
# 全局安装
npm install -g .

# 或者使用 npm link
npm link
```

## 命令概览

```bash
finger --help
```

### 基础命令

| 命令 | 说明 |
|------|------|
| `finger understand <input>` | 语义理解 |
| `finger route --intent <json>` | 路由决策 |
| `finger plan <task>` | 任务规划 |
| `finger execute --task <desc>` | 任务执行 |
| `finger review --proposal <json>` | 质量审查 |
| `finger orchestrate <task>` | 编排协调 |

### 工作流控制

| 命令 | 说明 |
|------|------|
| `finger status <workflowId>` | 查看状态 |
| `finger list` | 列出所有工作流 |
| `finger pause <workflowId>` | 暂停工作流 |
| `finger resume <workflowId>` | 恢复工作流 |
| `finger input <workflowId> <input>` | 发送输入 |

### 交互模式

| 命令 | 说明 |
|------|------|
| `finger repl` | 启动交互式 REPL |

## 使用示例

### 1. 启动 Daemon

```bash
# 启动后台服务
finger daemon start

# 查看状态
finger daemon status

# 停止服务
finger daemon stop
```

### 2. REPL 模式

```bash
finger repl
```

进入交互式界面：

```
Finger REPL v1.0.0
Type /help for available commands

Connecting to daemon...
Connected ✓

> 搜索 deepseek 最新发布
[10:00:00] Started workflow: wf-123456

[wf-123456] > [10:00:01] Phase: idle → semantic_understanding
[10:00:02] Phase: semantic_understanding → plan_loop
[10:00:03] Plan created: 3 tasks

❓ 检测到网络访问，是否继续？(Y/n)
> Y

[10:00:05] Task 1: started - 网络搜索
[10:00:10] Task 1: completed ✓
...

> /status
Workflow: wf-123456
Status: executing (execution)

> /list
Workflows:
  wf-123456: execution (executing) *

> /pause
✓ Workflow paused

> /exit
Goodbye!
```

### 3. 单次命令

```bash
# 执行单个任务
finger orchestrate "搜索 deepseek 最新发布" --watch

# 查看工作流状态
finger status wf-123456

# 发送输入
finger input wf-123456 "继续执行"
```

## REPL 内置命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/status` | 当前工作流状态 |
| `/list` | 列出所有工作流 |
| `/pause` | 暂停当前工作流 |
| `/resume` | 恢复当前工作流 |
| `/cancel` | 取消当前工作流 |
| `/switch <id>` | 切换到另一个工作流 |
| `/new` | 开始新会话 |
| `/json` | 切换输出格式为 JSON |
| `/text` | 切换输出格式为文本 |
| `/clear` | 清屏 |
| `/exit` | 退出 REPL |

## 输出格式

### 文本模式（默认）

```
[10:00:00] Phase: idle → semantic_understanding
[10:00:01] Task task-1: started - 搜索
[10:00:05] Task task-1: completed ✓
```

### JSON 模式

```json
{"type":"phase_transition","payload":{"from":"idle","to":"semantic_understanding"},"timestamp":"..."}
{"type":"task_started","payload":{"taskId":"task-1"},"timestamp":"..."}
```

## 错误码

| 退出码 | 说明 |
|--------|------|
| 0 | 成功 |
| 1 | 通用错误 |
| 2 | 参数错误 |
| 3 | 连接错误（Daemon 未启动） |
| 4 | 资源缺失 |
| 5 | 任务失败 |
| 6 | 用户取消 |
| 7 | 超时 |

## 环境变量

```bash
# HTTP API 地址
export FINGER_HTTP_URL=http://localhost:8080

# WebSocket 地址
export FINGER_WS_URL=ws://localhost:8081
```

## 配置文件

配置目录位于 `~/.finger/config/`：

- `config.json`（全局 / Provider 配置）
- `inputs.yaml` / `outputs.yaml` / `routes.yaml`（核心 daemon 配置）

---

详细设计见：
- [CLI_DESIGN.md](./CLI_DESIGN.md) - 设计文档
- [CLI_IMPLEMENTATION_PLAN.md](./CLI_IMPLEMENTATION_PLAN.md) - 实现计划
- [CLI_CALL_FLOW.md](./CLI_CALL_FLOW.md) - 调用流程
