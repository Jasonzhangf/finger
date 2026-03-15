# System Agent 实施计划

## 实施总览

基于 `DESIGN.md` 的设计，本计划分 6 个 Phase 实施，优先级从高到低。

## Phase 1: 基础设施（高优先级）

### 1.1 创建提示词加载器

**文件**: `src/agents/finger-system-agent/prompt-loader.ts`

**任务**:
- [ ] 实现 `loadPrompt()` 函数
- [ ] 实现 `stripFrontMatter()` 函数
- [ ] 实现优先级加载逻辑（用户版本 > dist 模板）
- [ ] 实现缓存机制
- [ ] 实现 `clearPromptCache()` 和 `reloadPrompt()`

**验收标准**:
- 可以加载 `~/.finger/system/` 下的提示词文件
- 用户版本优先于 dist 模板
- 缓存正常工作
- 支持热更新

### 1.2 创建配置文件模板

**目录**: `docs/reference/templates/system-agent/`

**任务**:
- [ ] 创建 `SOUL.md` 模板
- [ ] 创建 `IDENTITY.md` 模板
- [ ] 创建 `HEARTBEAT.md` 模板
- [ ] 创建 `system-prompt.md` 模板（扩展现有）
- [ ] 创建 `capability.md` 模板（扩展现有）

**目录**: `docs/reference/templates/system-agent/roles/`

**任务**:
- [ ] 创建 `user-interaction.md` 模板
- [ ] 创建 `agent-coordination.md` 模板
- [ ] 创建 `task-dispatcher.md` 模板
- [ ] 创建 `task-reporter.md` 模板
- [ ] 创建 `mailbox-handler.md` 模板

**验收标准**:
- 所有模板文件格式正确
- 支持 YAML front matter
- 内容符合设计文档

### 1.3 实现 Agent 注册表

**文件**: `src/agents/finger-system-agent/registry.ts`

**任务**:
- [ ] 定义 `AgentRegistry` 接口
- [ ] 实现 `loadRegistry()` 函数
- [ ] 实现 `saveRegistry()` 函数
- [ ] 实现 `registerAgent()` 函数
- [ ] 实现 `unregisterAgent()` 函数
- [ ] 实现 `updateAgent()` 函数
- [ ] 实现 `listAgents()` 函数
- [ ] 实现 `getAgentStatus()` 函数

**数据结构**:
```typescript
interface AgentRegistry {
  version: number;
  lastUpdate: string;
  agents: Record<string, AgentInfo>;
}

interface AgentInfo {
  projectId: string;
  projectPath: string;
  projectName: string;
  agentId: string;
  status: 'idle' | 'busy' | 'stopped' | 'crashed';
  lastHeartbeat: string;
  lastSessionId?: string;
  stats: {
    tasksCompleted: number;
    tasksFailed: number;
    uptime: number;
  };
}
```

**验收标准**:
- 可以加载/保存 `registry.json`
- 注册、注销、更新 agent 正常工作
- 可以查询 agent 状态

### 1.4 实现 System Registry Tool

**文件**: `src/tools/internal/system-registry-tool.ts`

**任务**:
- [ ] 定义工具接口
- [ ] 实现 `register` action
- [ ] 实现 `unregister` action
- [ ] 实现 `update` action
- [ ] 实现 `list` action
- [ ] 实现 `get_status` action
- [ ] 注册到工具注册表（`policy: 'allow'`，仅 System Agent 可用）

**验收标准**:
- 工具可以正常调用
- 权限控制正确
- 与 registry 集成正常

### 1.5 更新 capability.md

**文件**: `~/.finger/system/capability.md`（运行时）

**任务**:
- [ ] 添加提示词加载说明
- [ ] 添加多角色说明
- [ ] 添加 Agent 注册表工具说明
- [ ] 添加定时器说明

**验收标准**:
- 文档完整准确
- 符合现有格式

---

## Phase 2: 多角色提示词体系（高优先级）

### 2.1 实现角色管理器

**文件**: `src/agents/finger-system-agent/role-manager.ts`

**任务**:
- [ ] 定义角色类型
- [ ] 实现 `switchRole()` 函数
- [ ] 实现 `getCurrentRole()` 函数
- [ ] 实现角色上下文管理

**角色类型**:
```typescript
type SystemRole = 
  | 'user-interaction'
  | 'agent-coordination'
  | 'task-dispatcher'
  | 'task-reporter'
  | 'mailbox-handler';
```

**验收标准**:
- 可以切换角色
- 可以获取当前角色
- 上下文管理正确

### 2.2 实现角色提示词加载

**任务**:
- [ ] 集成 `prompt-loader.ts`
- [ ] 为每个角色实现提示词加载
- [ ] 实现角色切换时的提示词切换

**验收标准**:
- 每个角色可以加载对应的提示词
- 切换角色时提示词正确更新

### 2.3 创建角色提示词模板

**任务**:
- [ ] 编写 `user-interaction.md` 提示词
- [ ] 编写 `agent-coordination.md` 提示词
- [ ] 编写 `task-dispatcher.md` 提示词
- [ ] 编写 `task-reporter.md` 提示词
- [ ] 编写 `mailbox-handler.md` 提示词

**验收标准**:
- 每个提示词内容完整
- 符合设计文档
- 可以直接使用

### 2.4 更新 system-prompt.md

**文件**: `~/.finger/system/system-prompt.md`

**任务**:
- [ ] 添加多角色说明
- [ ] 添加角色切换机制
- [ ] 保持向后兼容

**验收标准**:
- 提示词完整
- 向后兼容

---

## Phase 3: 定时检查（高优先级）

### 3.1 实现定时器

**文件**: `src/agents/finger-system-agent/timer.ts`

**任务**:
- [ ] 实现 `SystemTimer` 类
- [ ] 实现 5 分钟定时器
- [ ] 实现定时器启动/停止
- [ ] 实现定时器生命周期管理

**验收标准**:
- 定时器正常工作
- 可以启动/停止
- 与 Daemon 生命周期绑定

### 3.2 实现状态检测器

**文件**: `src/agents/finger-system-agent/status-detector.ts`

**任务**:
- [ ] 实现 `detectAgentStatus()` 函数
- [ ] 集成 `AgentRuntimeBlock.getRuntimeView()`
- [ ] 实现状态判断逻辑（idle/busy/error/queued）
- [ ] 实现状态更新

**验收标准**:
- 可以正确检测 agent 状态
- 状态更新正确

### 3.3 实现心跳发���器

**文件**: `src/agents/finger-system-agent/heartbeat-sender.ts`

**任务**:
- [ ] 实现 `sendHeartbeatPrompt()` 函数
- [ ] 实现心跳间隔检查（5 分钟）
- [ ] 实现心跳提示词构建
- [ ] 集成 `AgentRuntimeBlock.dispatchTask()`
- [ ] 集成 `SessionControlPlaneStore`

**验收标准**:
- 可以发送心跳提示词
- 间隔检查正确
- 使用正确的 session

### 3.4 实现定时检查流程

**文件**: `src/agents/finger-system-agent/periodic-check.ts`

**任务**:
- [ ] 实现完整的定时检查流程
- [ ] 集成状态检测器
- [ ] 集成心跳发送器
- [ ] 实现 registry 更新
- [ ] 实现 HEARTBEAT.md 任务执行

**验收标准**:
- 定时检查流程完整
- 各组件集成正常

---

## Phase 4: 任务报告（中优先级）

### 4.1 实现 Report Task Completion Tool

**文件**: `src/tools/internal/report-task-completion-tool.ts`

**任务**:
- [ ] 定义工具接口
- [ ] 实现 `report` action
- [ ] 注册到工具注册表（`policy: 'allow'`，仅 Project Agents 可用）

**接口**:
```typescript
interface ReportTaskCompletionInput {
  action: 'report';
  taskId: string;
  taskSummary: string;
  sessionId: string;
  result: 'success' | 'failure';
  projectId: string;
}
```

**验收标准**:
- 工具可以正常调用
- 权限控制正确

### 4.2 实现任务报告处理器

**文件**: `src/agents/finger-system-agent/task-report-processor.ts`

**任务**:
- [ ] 实现 `processTaskReport()` 函数
- [ ] 集成 memory-tool（记录到 MEMORY.md）
- [ ] 实现 registry 统计信息更新
- [ ] 实现 Review 分配逻辑

**验收标准**:
- 可以处理任务报告
- 记忆记录正常
- registry 更新正常

### 4.3 实现 Review 分配器

**文件**: `src/agents/finger-system-agent/review-dispatcher.ts`

**任务**:
- [ ] 实现 `dispatchReview()` 函数
- [ ] 创建 review 任务描述
- [ ] 集成 `AgentRuntimeBlock.dispatchTask()`
- [ ] 目标 agent: `finger-reviewer`
- [ ] 实现等待 review 结果

**验收标准**:
- 可以分配 review 任务
- review 结果可以正确处理

---

## Phase 5: WebSocket 推送（中优先级）

### 5.1 定义 WebSocket 事件类型

**文件**: `src/agents/finger-system-agent/websocket-events.ts`

**任务**:
- [ ] 定义 `AgentStatusChangedEvent`
- [ ] 定义 `TaskCompletedEvent`
- [ ] 定义 `AgentRegisteredEvent`
- [ ] 定义 `AgentUnregisteredEvent`

**事件类型**:
```typescript
interface SystemAgentEvent {
  type: 'agent_status_changed' | 'task_completed' | 'agent_registered' | 'agent_unregistered';
  data: {
    agents: AgentInfo[];
    timestamp: string;
  };
}
```

**验收标准**:
- 事件类型定义完整
- 符���现有 WebSocket 机制

### 5.2 实现状态变化推送

**任务**:
- [ ] 实现 `pushStatusChange()` 函数
- [ ] 集成到状态检测器
- [ ] 实现事件推送逻辑

**验收标准**:
- 状态变化可以正常推送
- 事件格式正确

### 5.3 实现任务完成推送

**任务**:
- [ ] 实现 `pushTaskCompletion()` 函数
- [ ] 集成到任务报告处理器
- [ ] 实现事件推送逻辑

**验收标准**:
- 任务完成可以正常推送
- 事件格式正确

---

## Phase 6: UI 集成（低优先级）

### 6.1 添加"系统监控"选项

**位置**: 项目会话侧栏菜单

**任务**:
- [ ] 在侧栏菜单添加"系统监控"选项
- [ ] 实现选项点击处理
- [ ] 调用 System Registry API 持久化监控开关

**验收标准**:
- 选项显示正常
- 点击可以打开系统监控

### 6.2 实现 Agent 状态显示

**任务**:
- [ ] 实现 Agent 状态列表显示
- [ ] 显示 agent 状态信息
- [ ] 监控列表来源切换为 System Registry

**验收标准**:
- 状态显示正确
- 信息完整

### 6.3 实现 2x2 Grid 布局

**任务**:
- [ ] 实现 2x2 grid 布局
- [ ] 显示最近活跃的 4 个项目
- [ ] 超过 4 个不显示但继续工作
- [ ] 使用 monitorUpdatedAt 排序

**验收标准**:
- 布局正确
- 显示逻辑正确

### 6.4 实现 WebSocket 事件监听

**任务**:
- [ ] 实现事件监听
- [ ] 实现状态更新
- [ ] 实现实时刷新
- [ ] System Registry 变更后刷新监控列表

**验收标准**:
- 事件监听正常
- 状态实时更新

---

## 集成测试计划

### 测试场景

1. **提示词加载测试**
   - 用户版本优先级
   - dist 模板初始化
   - 缓存机制
   - 热更新

2. **多角色测试**
   - 角色切换
   - 提示词切换
   - 上下文管理

3. **定时检查测试**
   - 定时器触发
   - 状态检测
   - 心跳发送
   - registry 更新

4. **任务报告测试**
   - 工具调用
   - 报告处理
   - Review 分配

5. **WebSocket 推送测试**
   - 状态变化推送
   - 任务完成推送

6. **UI 集成测试**
   - 系统监控显示
   - Agent 状态显示
   - 2x2 grid 布局
   - 实时更新

---

## 验收标准

### Phase 1 验收标准
- [ ] 提示词加载器正常工作
- [ ] 配置文件模板完整
- [ ] Agent 注册表正常工作
- [ ] System Registry Tool 可用
- [ ] capability.md 更新完成

### Phase 2 验收标准
- [ ] 角色管理器正常工作
- [ ] 多角色提示词加载正常
- [ ] 所有角色提示词完整
- [ ] system-prompt.md 更新完成

### Phase 3 验收标准
- [ ] 定时器正常工作
- [ ] 状态检测正常
- [ ] 心跳发送正常
- [ ] 定时检查流程完整

### Phase 4 验收标准
- [ ] Report Task Completion Tool 可用
- [ ] 任务报告处理正常
- [ ] Review 分配正常

### Phase 5 验收标准
- [ ] WebSocket 事件定义完整
- [ ] 状态变化推送正常
- [ ] 任务完成推送正常

### Phase 6 验收标准
- [ ] "系统监控"选项可用
- [ ] Agent 状态显示正常
- [ ] 2x2 grid 布局正确
- [ ] WebSocket 事件监听正常

---

## 风险与缓解

### 风险 1: 提示词加载失败
**缓解**: 提供默认提示词，确保系统可用

### 风险 2: 定时器阻塞主线程
**缓解**: 使用异步操作，避免阻塞

### 风险 3: 心跳发送干扰正常工作
**缓解**: 严格检查 agent 状态，只向 idle agent 发送

### 风险 4: WebSocket 推送失败
**缓解**: 记录错误，不影响主流程

### 风险 5: UI 集成影响性能
**缓解**: 使用虚拟滚动，限制显示数量

---

## 实施顺序

1. **Week 1**: Phase 1（基础设施）
2. **Week 2**: Phase 2（多角色提示词体系）
3. **Week 3**: Phase 3（定时检查）
4. **Week 4**: Phase 4（任务报告）
5. **Week 5**: Phase 5（WebSocket 推送）
6. **Week 6**: Phase 6（UI 集成）+ 测试

---

## 后续优化

1. 性能优化：缓存优化、批量操作
2. 监控：添加系统监控指标
3. 日志：完善日志记录
4. 文档：更新用户文档
