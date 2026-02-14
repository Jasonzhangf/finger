# 基于 bd 的 Agent 协作工作流程

## 核心原则

1. **bd 是单一事实来源**: 所有任务状态、沟通记录、交付物都在 bd 中管理
2. **Issue 驱动**: 每个任务是一个 bd issue，有明确的验收标准
3. **状态透明**: Agent 定期更新 issue 状态，其他 Agent 可实时查看
4. **变更可控**: 任何变更都通过 bd 的依赖和阻塞机制管理

## Issue 类型与状态

### Issue 类型

| 类型 | 用途 | 创建者 |
|------|------|--------|
| `epic` | 大项目/里程碑 | Orchestrator |
| `task` | 具体执行任务 | Orchestrator/分解 |
| `review` | 审查请求 | Executor |
| `bug` | 发现的问题 | Reviewer/Agent |
| `change` | 变更请求 | 任何 Agent |
| `question` | 阻塞/疑问 | 任何 Agent |
| `decision` | 需要决策的事项 | Orchestrator |

### Issue 状态流转

```
open → in_progress → [blocked] → review → closed
              ↓
           failed → [retry/escalate]
```

## 角色与 bd 的交互

### 1. Orchestrator 与 bd

**任务分解时**:
```bash
# 创建 Epic
bd --no-db create "实现用户登录功能" -p 0 --type epic \
  --acceptance "1. 用户可通过邮箱密码登录\n2. 密码加密存储\n3. 会话保持24小时"

# 创建子任务
bd --no-db create "设计登录模块架构" -p 1 --type task \
  --parent <epic-id> \
  --assignee architect \
  --acceptance "输出架构文档，包含API设计"

bd --no-db create "实现登录API" -p 1 --type task \
  --parent <epic-id> \
  --assignee executor \
  --acceptance "代码通过测试，API可调用"

# 建立依赖
bd --no-db dep add <task-api> <task-arch>  # API 依赖架构
```

**调度决策时**:
```bash
# 标记非主设任务可并行
bd --no-db update <task-id> --label parallel

# 标记主设任务
bd --no-db update <task-id> --label main-path

# 查询可执行的任务
bd --no-db ready  # 无 blocker 的 open/in_progress
```

### 2. Executor 与 bd

**领取任务**:
```bash
# Claim 任务
bd --no-db update <task-id> --status in_progress --assignee executor-1

# 添加备注
bd --no-db comment <task-id> "开始执行，预计30分钟"
```

**执行过程中**:
```bash
# 遇到阻塞
bd --no-db create "API设计不明确" -p 2 --type question \
  --parent <task-id> \
  --blocker <task-id>

# 进度更新
bd --no-db comment <task-id> "已完成数据库模型，正在写API"
```

**完成时**:
```bash
# 标记完成，附上交付物
bd --no-db close <task-id> \
  --reason "已完成" \
  --suggest-next "请求代码审查" \
  --note "交付物:\n- src/auth/login.ts\n- tests/auth/login.test.ts"

# 创建审查请求
bd --no-db create "审查登录API实现" -p 1 --type review \
  --parent <epic-id> \
  --assignee reviewer \
  --acceptance "1. 代码规范\n2. 测试覆盖\n3. 无安全漏洞"
```

### 3. Reviewer 与 bd

**审查通过**:
```bash
bd --no-db close <review-id> \
  --reason "审查通过" \
  --note "检查项全部通过，建议合并"
```

**审查发现问题**:
```bash
# 创建 bug issue
bd --no-db create "登录API缺少输入校验" -p 2 --type bug \
  --parent <epic-id> \
  --assignee executor-1 \
  --blocker <review-id> \
  --acceptance "添加邮箱格式校验和密码强度检查"

# 备注审查意见
bd --no-db comment <review-id> "发现以下问题:\n1. 缺少输入校验\n2. 错误信息不够友好"
```

## 交付物管理

### 交付物关联

每个 issue 的 notes 字段包含交付物清单：

```json
{
  "deliverables": [
    {
      "type": "file",
      "path": "src/auth/login.ts",
      "checksum": "sha256:abc123...",
      "description": "登录API实现"
    },
    {
      "type": "file",
      "path": "tests/auth/login.test.ts",
      "checksum": "sha256:def456...",
      "description": "单元测试"
    },
    {
      "type": "doc",
      "path": "docs/auth-api.md",
      "description": "API文档"
    }
  ]
}
```

### 自动同步机制

ProjectBlock 定期同步：
```typescript
// 从 bd 读取任务状态
const tasks = await bd.list({ status: 'in_progress' });

// 更新到内部状态
for (const task of tasks) {
  await taskBlock.updateStatus(task.id, task.status);
}

// 将 Agent 执行结果写回 bd
await bd.update(taskId, {
  status: 'closed',
  notes: JSON.stringify({ deliverables: artifacts })
});
```

## 变更管理流程

### 场景1: 需求变更

```
1. Orchestrator 发现需求需要调整
2. bd create "变更: 添加手机号登录" --type change
3. bd dep add <change-issue> <epic-id>  # 变更影响 Epic
4. Orchestrator 评估影响，创建新任务
5. 原任务根据影响决定: 继续/修改/废弃
6. 所有相关 Agent 通过 bd 收到通知
```

### 场景2: 代码回滚

```
1. Reviewer 发现严重问题
2. bd create "回滚请求: 登录API有安全漏洞" --type change -p 0
3. bd dep add <rollback-issue> <task-id>
4. Executor 执行回滚
5. bd close <task-id> --reason "已回滚"
6. bd create "重新实现登录API" --type task (新任务)
```

## 沟通机制

### 1. 异步沟通 (bd comment)

```bash
# Agent A 提问
bd --no-db comment <task-id> "这里的错误码应该用什么规范？"

# Agent B (Orchestrator) 回复
bd --no-db comment <task-id> "参考 docs/error-codes.md，使用 AUTH_001 格式"
```

### 2. 紧急阻塞 (bd blocker)

```bash
# Agent 遇到无法解决的问题
bd --no-db update <task-id> --status blocked
bd --no-db create "紧急: 数据库连接失败" --type question \
  --blocker <task-id> \
  -p 0

# Orchestrator 收到通知，协调资源
bd --no-db comment <question-id> "正在检查，预计5分钟"
```

### 3. 决策请求 (bd decision)

```bash
# 需要高层决策
bd --no-db create "决策: 使用JWT还是Session" --type decision \
  --parent <epic-id> \
  --acceptance "明确认证方案，包含理由"

# 多方讨论
bd --no-db comment <decision-id> "Architect: 建议JWT，因为..."
bd --no-db comment <decision-id> "SecurityAuditor: 考虑到...建议Session"

# Orchestrator 做决策并关闭
bd --no-db close <decision-id> --reason "采用JWT，理由：..."
```

## 主设/非主设任务的 bd 标记

### 标记方式

```bash
# 主设任务 (阻塞后续关键路径)
bd --no-db update <task-id> --label main-path --priority 0

# 非主设任务 (可并行执行)
bd --no-db update <task-id> --label parallel --priority 1
```

### 调度查询

```bash
# 获取非主设任务（优先执行）
bd --no-db list --status open --label parallel

# 获取主设任务（检查依赖是否完成）
bd --no-db list --status open --label main-path

# 检查某个主设任务的依赖是否完成
bd --no-db dep list <task-id>  # 查看阻塞该任务的所有 issue
```

## Agent 状态同步

### AgentBlock 的 bd 集成

```typescript
interface AgentStateInBd {
  agentId: string;
  role: string;
  status: 'idle' | 'busy' | 'error';
  currentTask?: string;  // bd issue id
  lastHeartbeat: Date;
  capabilities: string[];
}

// 每个 Agent 定期上报状态
await bd.update(`agent-${agentId}`, {
  notes: JSON.stringify(agentState)
});

// Orchestrator 查询所有 Agent 状态
const agents = await bd.list({ title-contains: 'agent-' });
```

## 完整示例：实现登录功能

```bash
# === Phase 1: 项目初始化 ===
finger project init "用户认证系统"
# 内部执行: bd init --no-db

# === Phase 2: Orchestrator 分解任务 ===
bd create "实现用户登录功能" --type epic -p 0

bd create "设计登录架构" --type task --parent epic-1 --label parallel
bd create "准备测试环境" --type task --parent epic-1 --label parallel
bd create "实现登录API" --type task --parent epic-1 --label main-path
bd dep add task-api task-arch

bd create "编写登录测试" --type task --parent epic-1 --label parallel
bd dep add task-test task-api

bd create "审查登录实现" --type task --parent epic-1
bd dep add task-review task-api
bd dep add task-review task-test

# === Phase 3: 并行执行非主设任务 ===
# Architect 领取 task-arch
bd update task-arch --status in_progress --assignee agent-arch-1
# ... 执行 ...
bd close task-arch --reason "完成" --note "交付物: docs/auth-arch.md"

# === Phase 4: 执行主设任务 ===
# Executor 领取 task-api（等待 task-arch 完成）
bd ready  # 显示 task-api 现在可执行
bd update task-api --status in_progress --assignee agent-exec-1
# ... 执行 ...
bd close task-api --reason "完成" --note "交付物: src/auth/login.ts"

# === Phase 5: 审查 ===
bd update task-review --status in_progress --assignee agent-rev-1
# Reviewer 发现问题
bd create "登录API缺少限流" --type bug --blocker task-review
# Executor 修复
bd close bug-1 --reason "已修复"
bd close task-review --reason "审查通过"

# === Phase 6: 完成 Epic ===
bd epic status epic-1  # 检查所有子任务完成
bd close epic-1 --reason "功能完成"
```

## 关键约定

1. **所有沟通在 bd**: 不使用其他渠道，保证可追溯
2. **交付物在 notes**: 关闭 issue 时必须附上交付物清单
3. **阻塞立即标记**: 遇到问题立即 `--status blocked` 并创建 blocker issue
4. **决策有记录**: 重要决策创建 decision issue，包含理由
5. **Agent 状态同步**: 每个 Agent 定期更新自身状态到 bd
