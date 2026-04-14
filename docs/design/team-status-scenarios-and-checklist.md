# Team Status 功能场景设计与验证 Checklist

## 概述

本文档定义 `team.status` 功能在实际使用场景中的设计，并提供验证 checklist。

---

## 一、用户功能清单

### 1.1 System Agent 功能

| 功能编号 | 功能名称 | 描述 | 优先级 |
|----------|----------|------|--------|
| S1 | 启动 Project Agent | System Agent 启动时，根据 registry.monitored 自动启动 Project Agent | P0 |
| S2 | 监控 Agent 状态 | 每 5 分钟检查所有 monitored agents 的运行状态 | P0 |
| S3 | 查看 Team Status | System Agent 可查看所有 agents 的状态（全局视角） | P0 |
| S4 | 派发任务前检查状态 | 派发任务前检查目标 agent 是否 busy，避免冲突 | P1 |
| S5 | 心跳提示词 | 对 idle agents 发送心跳提示词，触发主动性 | P1 |

### 1.2 Project Agent 功能

| 功能编号 | 功能名称 | 描述 | 优先级 |
|----------|----------|------|--------|
| P1 | 查看同项目 Team Status | Project Agent 可查看同项目内其他 agents + system agent 的状态 | P0 |
| P2 | 更新自己的 Plan Summary | 通过 `update_plan` 工具自动同步 planSummary 到 team.status | P0 |
| P3 | 查看自己的状态 | 通过 `team.status` 工具查看自己的 runtimeStatus + planSummary | P1 |
| P4 | 状态变化自动同步 | runtimeStatus 变化时自动同步到 team.status（由 PeriodicCheckRunner 完成） | P0 |

### 1.3 Team Status 工具功能

| 功能编号 | 功能名称 | 描述 | 优先级 |
|----------|----------|------|--------|
| T1 | status action | 查询可见范围内的 team status（scope 过滤） | P0 |
| T2 | update action | 更新自己的 planSummary（需校验 agentId === context.agentId） | P0 |
| T3 | Scope 过滤 | System agent 看全部；Project agent 看同项目 + system agent | P0 |

---

## 二、实际使用场景

### 场景 1：System Agent 启动并控制 Project Agent

**前置条件**：
- `~/.finger/system/registry.json` 中有 monitored=true 的项目
- Daemon 未运行

**流程**：
```
1. 用户启动 daemon：pnpm daemon:start
2. daemon → SystemAgentManager.start()
   → deploySystemAgent()
   → PeriodicCheckRunner.start()
   → runner.runOnceImmediately()
3. PeriodicCheckRunner.runOnce()
   → 获取 runtime_view
   → 检查 monitored agents 是否运行
   → 对未运行的 monitored agents 调用 startProjectAgent()
   → 更新 team.status（runtimeStatus）
4. Project Agent 启动
   → System Agent 通过 team.status 知道 Project Agent 已 running
```

**验证点**：
- [ ] System Agent 启动后，registry.monitored=true 的 Project Agent 自动启动
- [ ] team.status 中有对应 agent 的记录，runtimeStatus=running
- [ ] 如果 registry.monitored=false，Project Agent 不启动

---

### 场景 2：Project Agent 执行任务并同步状态

**前置条件**：
- System Agent 已启动
- Project Agent 已启动
- Project Agent 有执行中的任务

**流程**：
```
1. Project Agent 执行任务
   → runtimeStatus 变为 running/busy
2. PeriodicCheckRunner.runOnce()（每 5 分钟）
   → 获取 runtime_view
   → 发现 Project Agent 状态变化
   → updateRuntimeStatus() 更新 team.status
3. Project Agent 使用 update_plan 工具
   → syncTeamStatusFromPlan() 自动同步 planSummary
4. System Agent 查看 team.status
   → 知道 Project Agent busy，plan 进度
   → 不派发新任务避免冲突
```

**验证点**：
- [ ] Project Agent 执行任务时，runtimeStatus 自动同步到 team.status
- [ ] Project Agent 使用 update_plan 后，planSummary 自动同步
- [ ] System Agent 可通过 team.status 查看 Project Agent 的进度

---

### 场景 3：多 Project Agent 协作（同项目）

**前置条件**：
- 同一项目有多个 Project Agent（如 finger-project-agent, finger-project-agent-2）
- 都在 registry 中注册，monitored=true

**流程**：
```
1. Agent-1 执行任务 A
   → runtimeStatus=running, planSummary.currentStep="任务A步骤3"
2. Agent-2 查看 team.status
   → 看到 Agent-1 状态：running, 任务A步骤3
   → Agent-2 决定不执行任务 A（避免冲突）
   → Agent-2 执行任务 B
3. Agent-1 完成任务 A
   → runtimeStatus=idle
   → planSummary.completed++
4. Agent-2 再次查看 team.status
   → 看到 Agent-1 已 idle
   → Agent-2 可接手新任务
```

**验证点**：
- [ ] 同项目的 Project Agents 可互相看到状态
- [ ] Agent 可根据 team.status 避免任务冲突
- [ ] 任务完成后状态自动更新

---

### 场景 4：Project Agent 查看 System Agent 状态

**前置条件**：
- Project Agent 已启动
- System Agent 已启动

**流程**：
```
1. Project Agent 调用 team.status（action=status）
2. filterTeamStatusByScope()
   → 返回：system-agent + 同项目的所有 project-agents
3. Project Agent 看到：
   - finger-system-agent: status=busy, lastTask="heartbeat check"
   - finger-project-agent（自己）: status=running, plan=3/5
   - finger-project-agent-2: status=idle
```

**验证点**：
- [ ] Project Agent 可看到 System Agent 状态
- [ ] Project Agent 只能看到同项目内的其他 agents
- [ ] 不能看到其他项目的 agents

---

### 场景 5：Agent 注销时清理 team.status

**前置条件**：
- Agent 已注册在 registry
- Agent 在 team.status 中有记录

**流程**：
```
1. System Agent 调用 system-registry-tool（action=unregister）
2. registry.unregisterAgent(projectId)
   → delete registry.agents[projectId]
   → removeTeamAgentStatus(agentId)
3. team.status 中该 agent 记录被删除
4. 其他 agents 查看 team.status 时，不再看到该 agent
```

**验证点**：
- [ ] unregister 时，team.status 记录被删除
- [ ] 其他 agents 查看时，不显示已注销的 agent

---

### 场景 6：System Agent 查看全局状态

**前置条件**：
- 多个项目有 Project Agents
- System Agent 已启动

**流程**：
```
1. System Agent 调用 team.status（action=status）
2. filterTeamStatusByScope()
   → viewerRole='system' → 返回所有 agents
3. System Agent 看到：
   - finger-system-agent: status=busy
   - finger-project-agent（项目A）: status=running, plan=5/10
   - finger-project-agent-2（项目A）: status=idle
   - finger-project-agent（项目B）: status=running, plan=2/5
```

**验证点**：
- [ ] System Agent 可查看所有项目的 agents
- [ ] 显示所有 agents 的 runtimeStatus + planSummary

---

## 三、测试 Checklist

### 3.1 单元测试（已创建）

| 测试编号 | 测试内容 | 状态 |
|----------|----------|------|
| U1 | loadTeamStatusStore / saveTeamStatusStore | ✅ 完成 |
| U2 | updateTeamAgentStatus（创建/更新） | ✅ 完成 |
| U3 | updateRuntimeStatus | ✅ 完成 |
| U4 | removeTeamAgentStatus | ✅ 完成 |
| U5 | filterTeamStatusByScope（system/project viewer） | ✅ 完成 |
| U6 | syncTeamStatusFromPlan | ✅ 完成 |

**测试文件**：`tests/unit/tools/team-status.test.ts`

---

### 3.2 集成测试（待创建）

| 测试编号 | 测试内容 | 状态 |
|----------|----------|------|
| I1 | team.status 工具 status action | ⏳ 待创建 |
| I2 | team.status 工具 update action | ⏳ 待创建 |
| I3 | PeriodicCheckRunner 更新 team.status | ⏳ 待创建 |
| I4 | update_plan → syncTeamStatusFromPlan | ⏳ 待创建 |
| I5 | unregister → removeTeamAgentStatus | ⏳ 待创建 |

---

### 3.3 场景测试（待创建）

| 测试编号 | 测试内容 | 状态 |
|----------|----------|------|
| S1 | System Agent 启动 Project Agent（monitored=true） | ⏳ 待创建 |
| S2 | System Agent 启动 Project Agent（monitored=false 不启动） | ⏳ 待创建 |
| S3 | 多 Project Agent 同项目协作（状态可见） | ⏳ 待创建 |
| S4 | Project Agent 查看 System Agent 状态 | ⏳ 待创建 |
| S5 | System Agent 查看全局状态 | ⏳ 待创建 |
| S6 | Agent 注销后 team.status 清理 | ⏳ 待创建 |

---

## 四、验证交付物

### 4.1 必须交付

| 交付物 | 状态 |
|--------|------|
| 场景设计文档（本文档） | ✅ 完成 |
| 单元测试 | ✅ 完成 |
| 集成测试 | ⏳ 待创建 |
| 场景测试 | ⏳ 待创建 |
| 测试运行报告 | ⏳ 待运行 |

### 4.2 功能覆盖矩阵

| 功能编号 | 单元测试 | 集成测试 | 场景测试 | 实际验证 |
|----------|----------|----------|----------|----------|
| S1（启动 PA） | - | - | S1 | ⏳ |
| S2（监控状态） | - | I3 | - | ⏳ |
| S3（查看 TS） | U5 | I1 | S5 | ⏳ |
| P1（查看同项目） | U5 | I1 | S3, S4 | ⏳ |
| P2（更新 Plan） | U6 | I4 | - | ⏳ |
| T1（status） | - | I1 | S3-S6 | ⏳ |
| T2（update） | U2 | I2 | - | ⏳ |
| T3（scope） | U5 | I1 | S3-S6 | ⏳ |

---

## 五、下一步行动

1. **创建集成测试**：`tests/integration/team-status.test.ts`
2. **创建场景测试**：`tests/scenarios/team-status-scenarios.test.ts`
3. **运行所有测试并生成报告**
4. **实际 daemon 启动验证**
5. **更新 checklist 状态**

---

## 六、完成标准

只有以下全部完成，才算功能交付完成：

- [ ] 所有单元测试通过
- [ ] 所有集成测试通过
- [ ] 所有场景测试通过
- [ ] Daemon 启动验证通过（System Agent 自动启动 Project Agent）
- [ ] team.status 工具在实际使用中可用
- [ ] 功能覆盖矩阵 100% ���满

