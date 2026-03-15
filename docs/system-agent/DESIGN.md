# System Agent 设计文档

## 概述

System Agent 是 Finger 系统的核心管理和协调组件，负责全局记忆管理、角色管理、心跳监控和任务编排。System Agent 作为 Daemon 主进程的一部分，确保所有 Project Agents 健康运行，知识得到妥善保存。

**注意**：System Agent 已经存在并与 QQBot 集成，本设计是在现有基础上的改造和扩展。

## 核心交互模式

System Agent 有三种不同的角色对话模式：

### 1. System Agent <> User

**场景**：用户通过 Channel/WebUI 与 System Agent 交互，分配任务

**特点**：
- 用户直接发起请求
- System Agent 作为系统管理者和协调者响应
- 支持高权限操作（需用户确认）
- 典型操作：配置管理、项目切换、系统维护

**提示词角色**：`user-interaction`

**示例**：
```
用户: 帮我创建一个新项目 /path/to/my-project
SystemBot: 好的，我将创建项目并分派 Orchestrator Agent...
```

### 2. System Agent <> Project Agent

**场景**：System Agent 分配任务给 Project Agent，Project Agent 报告任务进度

**特点**：
- 通过对话接口输入提示词，让 Agent 进行 reACT 推理
- System Agent 根据 role 有不同的提示词体系进行推理
- 双向通信：任务分配 + 进度报告

**子角色**：
- **task-dispatcher**：System Agent 向 Project Agent 分配任务
- **task-reporter**：Project Agent 向 System Agent 报告任务完成

**提示词角色**：`agent-coordination`

**示例**：
```
System Agent (task-dispatcher):
  执行项目 /path/to/my-project 的代码审查任务
  目标文件: src/agents/executor.ts
  重点关注: 性能优化和错误处理

Project Agent (task-reporter):
  任务完成: 代码审查
  结果: 发现 3 个问题，已修复
  详情: [问题列表]
```

### 3. Mailbox 处理

**场景**：System Agent 处理系统通知

**特点**：
- 主要是通知类消息
- 不需要复杂推理
- 需要及时响应或记录

**提示词角色**：`mailbox-handler`

**示例**：
```
Mailbox 消息:
  类型: system_alert
  内容: 磁盘空间不足，剩余 < 10%
  
System Agent:
  已记录到系统记忆
  建议: 清理过期会话文件
```

## 现有基础

### 已实现功能

1. **基本配置**: `SYSTEM_AGENT_CONFIG` (位于 `src/agents/finger-system-agent/index.ts`)
2. **提示词**: `system-prompt.md` 和 `system-dev-prompt.md`
3. **能力说明**: `capability.md` - 定义了 System Agent 的权限和操作流程
4. **工具**:
   - `project_tool` - 创建项目
   - `session.list` - 列出会话
   - `session.switch` - 切换会话
   - `memory-tool` - 系统记忆管理
5. **与 QQBot 集成** - 支持通过 QQBot 进行系统操作
6. **Mailbox 集成** - 支持 `MailboxBlock` 的消息处理

### 现有边界

1. **操作范围**: 仅允许操作 `~/.finger/system/`
2. **跨项目操作**: 通过 `project_tool.create` 分派给 Project Agent
3. **权限控制**: 高权限操作需要用户确认
4. **记忆隔离**: 系统记忆在 `~/.finger/system/MEMORY.md`，项目记忆在各项目根目录

## 核心职责（扩展）

现有的 System Agent 专注于配置管理和项目切换，新增以下职责：

1. **全局记忆管理**（已有基础，扩展功能）：
   - 维护所有项目的长期记忆
   - 定期整理和归档记忆
   - 记录系统级决策和操作

2. **角色管理**（新增）：
   - 管理所有"活着"的 Project Agents
   - 维护 Agent 注册表
   - 监控 Agent 生命周期
   - 多角色提示词体系

3. **心跳监控**（新增）：
   - 定期检查所有 agents 的状态
   - 对 idle 的 agents 发送心跳提示词
   - 处理心跳超时

4. **任务编排**（新增）：
   - 协调 agents 之间的任务分配
   - 分配 Review Agent 审查完成的任务
   - 记录任务进度
   - 支持 task-dispatcher 和 task-reporter 角色

5. **系统维护**（扩展）：
   - 定期执行系统级维护任务
   - 清理过期会话和缓存
   - 更新系统记忆

6. **通知处理**（扩展）：
   - 处理 Mailbox 通知
   - mailbox-handler 角色

## 设计原则

### 核心原则（保持不变）

- **被动优先**：只在收到请求或定时器触发时主动行动
- **最小干预**：不干扰正在工作的 agents
- **数据隔离**：严格区分项目记忆和系统记忆
- **安全第一**：所有操作必须经过权限检查

### 新增原则

- **角色分离**：不同交互模式使用不同的提示词角色
- **主动监控**：定期检查系统状态，但不主动干扰
- **事件驱动**：通过 WebSocket 推送状态变化
- **容错设计**：Agent 故障不应影响系统整体运行

### 禁止事项（保持不变）

- 不直接修改项目代码
- 不在 agent 工作时发送干扰消息
- 不暴露用户隐私数据
- 不执行未授权的系统命令

## 架构设计

### System Agent 位置

System Agent 是 Daemon 主进程的一部分，非独立进程。

### 核心组件

```
System Agent（现有）
├── 配置管理（已有）
├── 项目切换（已有）
├── 会话管理（已有）
├── QQBot 集成（已有）
├── Mailbox 集成（已有）
└── 扩展组件（新增）
    ├── 多角色提示词体系（新增）
    ├── 定时器（5 分钟）
    ├── 状态检测器
    ├── 心跳发送器
    ├── 任务报告处理器
    ├── Review 分配器
    └── WebSocket 推送器
```

### 多角色提示词体系

```
System Agent 提示词
├── system-prompt.md（主提示词）
├── roles/
│   ├── user-interaction.md（用户交互角色）
│   ├── agent-coordination.md（Agent 协调角色）
│   │   ├── task-dispatcher.md（任务分发子角色）
│   │   └── task-reporter.md（任务报告子角色）
│   └── mailbox-handler.md（Mailbox 处理角色）
└── capability.md（能力说明）
```

### 数据流

```
┌─────────────────────────────────────────────────────────────┐
│                        Daemon                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                   System Agent                        │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │  │
│  │  │  配置管理    │  │  项目切换    │  │  QQBot    │ │  │
│  │  │  (已有)      │  │  (已有)      │  │  (已有)   │ │  │
│  │  └──────────────┘  └──────────────┘  └────────────┘ │  │
│  │           ↓                  ↓                  ↓    │  │
│  │  ┌──────────────┐  ┌──────────────────────────────┐  │  │
│  │  │  Mailbox     │  │    Agent Registry (新增)     │  │  │
│  │  │  (已有)      │  │  ~/.finger/system/registry.json│  │
│  │  └──────────────┘  └──────────────────────────────┘  │  │
│  │           ↓                  ���                      │  │
│  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │         多角色提示词体系 (新增)              │  │  │
│  │  │  user-interaction | agent-coordination       │  │  │
│  │  │  task-dispatcher | task-reporter             │  │  │
│  │  │  mailbox-handler                             │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  │           ↓                                          │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │  │
│  │  │ 定时器       │→│ 状态检测器    │→│心跳发送器 │ │  │
│  │  │ (新增)       │  │  (新增)      │  │  (新增)   │ │  │
│  │  └──────────────┘  └──────────────┘  └────────────┘ │  │
│  │           ↓                  ↓                  ↑    │  │
│  │  ┌──────────────────┐  ┌────────────────────┐      │  │
│  │  │ Task Report      │  │ Review Assignment  │      │  │
│  │  │ Processor (新增)  │  │      (新增)         │      │  │
│  │  └──────────────────┘  └────────────────────┘      │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
           ↑                    ↑                    ↑
           │                    │                    │
    Project Agents       AgentRuntimeBlock      WebSocket
    (report task)         (query status)          (push events)
```

## 工作流程

### 1. 启动流程（扩展）

```
Daemon 启动
    ↓
初始化 System Agent（已有）
    ↓
读取 ~/.finger/system/SOUL.md（新增）
    ↓
读取 ~/.finger/system/IDENTITY.md（新增）
    ↓
读取 ~/.finger/system/HEARTBEAT.md（新增）
    ↓
加载多角色提示词体系（新增）
    ↓
加载 ~/.finger/system/registry.json（新增）
    ↓
启动 5 分钟定时器（新增）
    ↓
连接 Mailbox（已有）
    ↓
连接 WebSocket（推送状态更新）（新增）
```

### 2. 用户交互流程（已有）

```
用户通过 Channel/WebUI 发送请求
    ↓
System Agent 切换到 user-interaction 角色
    ↓
使用 user-interaction 提示词进行推理
    ↓
执行操作
    ↓
返回结果
```

### 3. Agent 协调流程（扩展）

#### 3.1 任务分发流程

```
System Agent 需要分配任务
    ↓
切换到 agent-coordination / task-dispatcher 角色
    ↓
使用 task-dispatcher 提示词构建任务描述
    ↓
通过 AgentRuntimeBlock.dispatchTask() 发送
    ↓
使用 Project Agent 的最新 session
    ↓
等待任务完成
```

#### 3.2 任务报告流程

```
Project Agent 完成任务
    ↓
调用 system_report_task_completion tool（新增）
    ↓
System Agent 切换到 agent-coordination / task-reporter 角色
    ↓
使用 task-reporter 提示词处理报告
    ↓
记录任务进度到 MEMORY.md（已有工具）
    ↓
更新 registry.json 统计信息
    ↓
分配 finger-reviewer agent 审查（如果需要）
    ↓
推送 task_completed 事件到 WebSocket
```

### 4. Mailbox 处理流程（已有，扩展）

```
Mailbox 收到通知
    ↓
System Agent 切换到 mailbox-handler 角色
    ↓
使用 mailbox-handler 提示词处理通知
    ↓
执行相应操作（记录、响应、转发等）
    ↓
更新 mailbox 状态
```

### 5. 定时检查流程（每 5 分钟）（新增）

```
定时器触发
    ↓
查询 AgentRuntimeBlock.getRuntimeView()
    ↓
遍历所有 agents
    ↓
检查状态：
  - idle → 发送心跳提示词
  - busy → 跳过
  - error → 记录错误
    ↓
更新 registry.json
    ↓
执行 HEARTBEAT.md 中的系统任务
    ↓
推送状态更新到 WebSocket
```

### 6. 心跳提示词发送流程（新增）

```
检测到 idle agent
    ↓
检查距离上次心跳 > 5 分钟
    ↓
切换到 agent-coordination / task-dispatcher 角色
    ↓
读取项目根目录的 HEARTBEAT.md
    ↓
构建心跳提示词
    ↓
通过 AgentRuntimeBlock.dispatchTask() 发送
    ↓
使用 agent 的最新 session（从 SessionControlPlaneStore 获取）
    ↓
assigner role 设置为 system
```

### 7. Review 分配流程（新增）

```
System Agent 收到任务报告
    ↓
切换到 agent-coordination / task-dispatcher 角色
    ↓
创建 review 任务
    ↓
通过 AgentRuntimeBlock.dispatchTask() 分配
    ↓
目标 agent: finger-reviewer
    ↓
等待 review 结果
    ↓
记录 review 结果到 MEMORY.md
    ↓
通知 Project Agent（如果需要）
```

## 提示词角色设计

### user-interaction 角色

**目标用户**：直接与 System Agent 交互的用户

**职责**：
- 理解用户意图
- 执行系统级操作
- 提供操作建议
- 权限确认

**提示词要点**：
- 简洁、直接
- 风险评估
- 权限检查
- 操作确认

### agent-coordination 角色

**目标用户**：Project Agents

**子角色**：

#### task-dispatcher

**职责**：
- 向 Project Agent 分配任务
- 提供清晰的任务描述
- 设置任务优先级
- 跟踪任务状态

**提示词要点**：
- 任务目标明确
- 输入参数清晰
- 期望结果具体
- 时间要求明确

#### task-reporter

**职责**：
- 接收 Project Agent 的任务报告
- 解析任务结果
- 记录任务进度
- 触发后续操作

**提示词要点**：
- 结果验证
- 错误处理
- 进度记录
- 后续动作

### mailbox-handler 角色

**目标用户**：Mailbox 系统

**职责**：
- 处理通知消息
- 分类通知类型
- 执行相应操作
- 记录通知历史

**提示词要点**：
- 通知识别
- 优先级判断
- 响应策略
- 记录规范

## 配置文件

### SOUL.md（新增）

System Agent 的核心原则和使命。

### IDENTITY.md（新增）

System Agent 的身份信息。

### HEARTBEAT.md（新增）

System Agent 定期任务清单（系统维护、记忆管理、安全检查）。

### registry.json（新增）

Agent 注册表，存储所有 Project Agents 的状态信息。

补充字段：
- `monitored`: 是否被 System Monitor 监控
- `monitorUpdatedAt`: 监控状态最后更新时间（用于排序）

### System Registry API（新增）

用于 UI 读取/更新系统监控状态：
- `GET /api/v1/system/registry`：列出 registry entries
- `POST /api/v1/system/registry/monitor`：设置 { projectPath, enabled }

### system-prompt.md（更新）

扩展提示词，添加多角色说明。

### capability.md（更新）

扩展能力说明，添加新工具和流程。

### roles/ 目录（新增）

存放各角色的提示词文件：
- `user-interaction.md`
- `agent-coordination.md`
- `task-dispatcher.md`
- `task-reporter.md`
- `mailbox-handler.md`

## 工具集成

### AgentRuntimeBlock（已有，扩展使用）

查询 agent 状态，dispatch 任务。

### Memory Tool（已有）

记录系统记忆和项目记忆。

### MailboxBlock（已有）

处理通知消息。

### SessionControlPlaneStore（已有）

获取 Agent 的最新 session。

### WebSocket（新增集成）

实时推送状态更新。

### System Registry Tool（新增）

管理 Agent 注册表（包含 monitor 状态持久化）。

### Report Task Completion Tool（新增）

Project Agent 报告任务完成。

## 安全考虑

1. **权限控制**：System Agent 专用工具通过 `policy: 'allow'` 限制访问（已有机制）
2. **数据隔离**：系统记忆与项目记忆分离（已有机制）
3. **最小权限**：System Agent 不直接修改项目代码（已有机制）
4. **审计日志**：记录所有重要操作（扩展记录）
5. **定时器安全**：定时器操作不阻塞主线程（新增）
6. **心跳安全**：心跳提示词发送不影响正在工作的 agents（新增）
7. **角色隔离**：不同角色有不同的权限和操作范围（新增）
8. **通知安全**：Mailbox 消息需要验证来源和权限（新增）

## 向后兼容性

1. **现有功能保持不变**：配置管理、项目切换、会话管理等现有功能不受影响
2. **渐进增强**：Project Agent 可以逐步集成 `system_report_task_completion` tool
3. **可选功能**：新增功能不影响不使用它的项目
4. **配置迁移**：不需要迁移现有配置，新功能独立运行
5. **提示词兼容**：现有 system-prompt.md 保持兼容，逐步扩展多角色

## 实施优先级

### Phase 1: 基础设施（高优先级）
1. 创建配置文件模板（SOUL.md, IDENTITY.md, HEARTBEAT.md）
2. 实现 Agent 注册表（registry.json）
3. 实现 System Registry Tool
4. 更新 capability.md

### Phase 2: 多角色提示词体系（高优先级）
1. 创建 roles/ 目录结构
2. 实现 user-interaction 角色
3. 实现 agent-coordination 角色
4. 实现 task-dispatcher 角色
5. 实现 task-reporter 角色
6. 实现 mailbox-handler 角色
7. 更新 system-prompt.md

### Phase 3: 定时检查（高优先级）
1. 实现 5 分钟定时器
2. 实现状态检测逻辑
3. 实现心跳提示词发送
4. 集成 SessionControlPlaneStore

### Phase 4: 任务报告（中优先级）
1. 实现 Report Task Completion Tool
2. 实现任务报告处理器
3. 实现 Review 分配

### Phase 5: WebSocket 推送（中优先级）
1. 定义 WebSocket 事件类型
2. 实现状态变化推送
3. 实现任务完成推送

### Phase 6: UI 集成（低优先级）
1. 在项目会话侧栏添加"系统监控"选项
2. 实现 Agent 状态显示
3. 实现 2x2 grid 布局
4. 实现 WebSocket 事件监听

## 关键假设

1. **定时器实现**: 使用 `setInterval`，每 5 分钟执行一次，与 Daemon 生命周期绑定
2. **状态检测**: 通过 `AgentRuntimeBlock.getRuntimeView()` 查询，结合 `status`、`runningCount`、`queuedCount` 判断
3. **心跳提示词**: 使用 Agent 的最新 session，通过 `dispatchTask` 发送，assigner role 为 system
4. **Session 来源**: 从 `SessionControlPlaneStore` 获取 Agent 的最新 session
5. **注册表存储**: JSON 格式，存储在 `~/.finger/system/registry.json`，程序读写，手动维护
6. **UI 可见性**: 用户通过"Open Project"打开路径，在项目会话侧栏菜单添加"系统监控"选项
7. **WebSocket 事件**: 复用现有机制，添加新的事件类型
8. **Review Agent**: 独立的 `finger-reviewer` agent，已定义在 startup templates 中
9. **Project Agent HEARTBEAT.md**: 位于项目根目录，项目级别的任务清单
10. **多角色提示词**: 根据交互上下文动态切换角色，使用对应的提示词进行推理

## 提示词加载优先级（2026-03-15 确认）

### 优先级规则

**~/.finger/system 下的 md 文件 > dist（安装包模板）**

### 加载流程

```
加载提示词
    ↓
尝试读取 ~/.finger/system/roles/*.md
    ↓
存在？ → 使用用户版本（调试优先，立即生效）
    ↓
不存在？ → 从 dist 模板初始化到 ~/.finger/system/roles/*.md
    ↓
返回内容
```

### 实现代码

```typescript
// src/agents/finger-system-agent/prompt-loader.ts

import { promises as fs } from 'fs';
import path from 'path';
import { FINGER_PATHS } from '../../core/finger-paths.js';

const DIST_TEMPLATES_PATH = path.join(FINGER_PACKAGE_ROOT, 'docs', 'reference', 'templates', 'system-agent');
const promptCache = new Map<string, Promise<string>>();

/**
 * 去除 Markdown 文件的 YAML front matter
 */
function stripFrontMatter(content: string): string {
  if (!content.startsWith('---')) {
    return content;
  }
  const endIndex = content.indexOf('\n---', 3);
  if (endIndex === -1) {
    return content;
  }
  const start = endIndex + '\n---'.length;
  let trimmed = content.slice(start);
  trimmed = trimmed.replace(/^\s+/, '');
  return trimmed;
}

/**
 * 加载提示词（优先级：用户版本 > dist 模板）
 * @param name 文件名（如 'system-prompt.md'）
 * @param role 角色路径（如 'roles'）
 * @returns 提示词内容（去除 front matter）
 */
export async function loadPrompt(name: string, role?: string): Promise<string> {
  const cacheKey = role ? `${role}/${name}` : name;

  const cached = promptCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    // 1. 尝试用户版本（优先级最高）
    const userPath = role
      ? path.join(FINGER_PATHS.home, 'system', role, name)
      : path.join(FINGER_PATHS.home, 'system', name);

    try {
      const content = await fs.readFile(userPath, 'utf-8');
      return stripFrontMatter(content);
    } catch {
      // 用户版本不存在，继续尝试 dist 模板
    }

    // 2. 从 dist 模板初始化
    const templatePath = role
      ? path.join(DIST_TEMPLATES_PATH, role, name)
      : path.join(DIST_TEMPLATES_PATH, name);

    try {
      const template = await fs.readFile(templatePath, 'utf-8');
      
      // 写入用户目录（初始化）
      await fs.mkdir(path.dirname(userPath), { recursive: true });
      await fs.writeFile(userPath, template, 'utf-8');
      
      return stripFrontMatter(template);
    } catch (error) {
      throw new Error(
        `Missing prompt: ${name} (tried user path: ${userPath} and dist template: ${templatePath})`
      );
    }
  })();

  promptCache.set(cacheKey, pending);
  try {
    return await pending;
  } catch (error) {
    promptCache.delete(cacheKey);
    throw error;
  }
}

/**
 * 清除提示词缓存（用于调试或热更新）
 */
export function clearPromptCache(): void {
  promptCache.clear();
}

/**
 * 重新加载提示词（清除缓存后重新加载）
 */
export async function reloadPrompt(name: string, role?: string): Promise<string> {
  const cacheKey = role ? `${role}/${name}` : name;
  promptCache.delete(cacheKey);
  return loadPrompt(name, role);
}
```

### 目录结构

```
~/.finger/system/                     # 用户配置目录（优先级最高）
├── SOUL.md
├── IDENTITY.md
├── HEARTBEAT.md
├── system-prompt.md
├── capability.md
└── roles/
    ├── user-interaction.md
    ├── agent-coordination.md
    ├── task-dispatcher.md
    ├── task-reporter.md
    └── mailbox-handler.md

docs/reference/templates/system-agent/          # 安装包模板（初始化用）
├── SOUL.md
├── IDENTITY.md
├── HEARTBEAT.md
├── system-prompt.md
├── capability.md
└── roles/
    ├── user-interaction.md
    ├── agent-coordination.md
    ├── task-dispatcher.md
    ├── task-reporter.md
    └── mailbox-handler.md
```

### 优势

1. **调试优先**：修改 `~/.finger/system/roles/*.md` 立即生效
2. **无需编译**：直接编辑 Markdown 文件
3. **默认可用**：首次启动自动从 dist 模板初始化
4. **版本控制**：dist 模板可以纳入 Git 版本控制
5. **热更新**：支持清除缓存重新加载
