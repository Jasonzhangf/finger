# 2026-03-09 当前状态分析

**时间**: 2026-03-09T10:14:28.335Z (UTC)

## 用户提出的问题

### 问题1: 空会话与编排者实例
**现象**: 空会话时 UI 显示有编排者实例
**用户期望**:
- 选项A: 空会话不应该有编排者实例
- 选项B: 使能的agent都有实例，禁用的关闭实例
- 空会话默认是编排器实例化
- 下面的agent打开就启动
- 该项目默认记住已经打开的agents

### 问题2: finger-general 无法关闭
**现象**: agent general无法关闭，出现在配置面板中
**用户期望**:
- finger-general 不应该出现在配置里面
- 在静态配置中添加+号作为标准模板出现
- 正常不应该有这个品类
- 配置面板隐藏finger-general
- 用它作为目标在ui创建新的agent

## 当前代码状态

### 已完成的修改
1. ✅ 隐藏 `finger-general` 在配置面板中的显示
   - 文件: `ui/src/hooks/useAgentRuntimePanel.ts`
   - 实现: 过滤掉 `finger-general`，不在 `configAgents` 中显示

2. ✅ 在 BottomPanel 添加 "+" 按钮基础UI
   - 文件: `ui/src/components/BottomPanel/BottomPanel.tsx`
   - 实现: 在 "Static Agent" 标题旁添加 "+" 按钮（UI占位，功能未实现）

### 待实现的修改

#### 1. 实现 "+" 按钮功能（P0）
**描述**: 使用 `finger-general` 作为模板创建新 agent
**涉及文件**:
- `ui/src/components/BottomPanel/BottomPanel.tsx` - 添加点击处理和对话框
- `src/server/routes/agent-configs.ts` - 新增创建 agent API（如果尚无）
- `src/runtime/agent-json-config.ts` - 复制 finger-general 配置

**实现步骤**:
1. BottomPanel 添加点击处理，弹出创建对话框
2. 预填充 finger-general 的配置（id, name, role, prompts 等）
3. 允许用户修改 id 和 name
4. 调用后端 API 保存新 agent 配置到 `~/.finger/runtime/agents/{new-id}/agent.json`
5. 刷新配置列表

#### 2. 实现空会话默认启动编排器
**描述**: 空会话时自动启动 finger-orchestrator 实例
**涉及文件**:
- `src/runtime/session-manager.ts` - 会话创建时启动编排器
- `src/runtime/runtime-facade.ts` - 协调启动逻辑

**实现步骤**:
1. 在 `SessionManager.createSession` 中添加启动编排器逻辑
2. 调用 `finger-orchestrator` 的启动流程
3. 等待编排器就绪后返回会话
4. 发送 session_created 事件，包含已启动的编排器信息

#### 3. 实现项目级记住已打开的 agents
**描述**: 每个项目记住用户已启用的 agents，下次打开自动恢复
**涉及文件**:
- `src/runtime/project-state.ts` (新建) - 项目状态管理
- `src/runtime/session-manager.ts` - 读取项目状态
- `src/server/routes/agent-configs.ts` - 更新项目状态 API

**实现步骤**:
1. 新建 `src/runtime/project-state.ts`，管理 `~/.finger/runtime/state/{project-hash}.json`
2. 存储格式: `{ projectPath, enabledAgents: string[], lastOpenedAt }`
3. 当用户启用/禁用 agent 时，调用 API 更新项目状态
4. 创建会话时，读取项目状态，自动启动已启用的 agents（包括编排器）
5. 如果没有项目状态（首次打开），默认只启动编排器

## 当前问题分析

### 问题1: 空会话与编排者实例
**根本原因**:
- 当前代码没有明确的"空会话默认启动编排器"逻辑
- 编排器实例的创建时机和条件不明确
- 项目级别的 agent 状态没有持久化

**解决方案**:
1. 实现"空会话默认启动编排器"（步骤2）
2. 实现"项目级记住已打开的 agents"（步骤3）
3. 当会话创建时：
   - 如果项目有状态：启动状态中的 agents
   - 如果没有状态：只启动编排器

### 问题2: finger-general 无法关闭
**根本原因**:
- `finger-general` 被设计为"通用 agent"，在多处代码中被引用
- 配置面板没有区分"可配置 agent"和"模板 agent"
- 没有机制使用 `finger-general` 作为模板创建新 agent

**解决方案**:
1. ✅ 隐藏 `finger-general` 在配置面板中的显示
2. ✅ 在 BottomPanel 添加 "+" 按钮基础UI
3. 实现 "+" 按钮功能（步骤1）：
   - 使用 `finger-general` 的配置作为模板
   - 允许用户修改 id 和 name
   - 保存为新 agent 配置到 `~/.finger/runtime/agents/{new-id}/`

## 下一步行动

按优先级顺序：

1. **实现 "+" 按钮功能**（P0）- 使用 finger-general 作为模板创建新 agent
   - 涉及: BottomPanel.tsx, agent-configs.ts, agent-json-config.ts

2. **实现空会话默认启动编排器**（P1）
   - 涉及: session-manager.ts, runtime-facade.ts

3. **实现项目级记住已打开的 agents**（P1）
   - 涉及: project-state.ts (新建), session-manager.ts, agent-configs.ts

等待用户指示从哪个步骤开始。

Tags: agent, session, finger-general, implementation-plan, status-report
