# Team Status 功能测试 Checklist

## 1. team.status 工具设计

### 1.1 team-status-state.ts
- [x] `TeamAgentStatus` 数据结构定义完整
- [x] `TeamStatusStore` 存储结构定义完整
- [x] `loadTeamStatusStore()` 函数实现
- [x] `saveTeamStatusStore()` 函数实现
- [x] `updateTeamAgentStatus()` 函数实现
- [x] `updateRuntimeStatus()` 函数实现
- [x] `syncTeamStatusFromPlan()` 函数实现
- [x] `filterTeamStatusByScope()` 函数实现
- [x] 持久化路径：`~/.finger/system/team-status.json`

### 1.2 team-status-tool.ts
- [x] `teamStatusTool` 工具定义完整
- [x] `status` action 实现完整
- [x] `update` action 实现完整
- [x] 权限校验：只能更新自己
- [x] Scope 可见性规则正确
- [x] 工具注册完整（Line 128: registry.register(teamStatusTool)）

### 1.3 测试验证 ✅
- [x] `team.status` 工具可以查询 team 状态 — tests/unit/tools/team-status.test.ts
- [x] `team.status` 工具可以更新 planSummary — tests/unit/tools/team-status.test.ts
- [x] Scope 可见性规则正确：System Agent 看到全部，Project Agent 看到同 project — tests/unit/tools/team-status.test.ts

## 2. SystemAgentManager 启动流程修改

### 2.1 启动流程
- [x] `SystemAgentManager.start()` 只启动 System Agent
- [x] `PeriodicCheckRunner` 控制启动 Project Agent
- [x] `PeriodicCheckRunner.runOnceImmediately()` 在启动时执行
- [x] `PeriodicCheckRunner.runOnce()` 更新 runtimeStatus
- [x] `PeriodicCheckRunner.sendHeartbeatPrompt()` 汇报 team.status

### 2.2 测试验证
- [ ] System Agent 启动后，PeriodicCheckRunner 自动启动 monitored Project Agent — 需要集成测试
- [ ] System Agent heartbeat prompt 包含 team.status 汇报 — 需要集成测试
- [ ] 重启后 system agent 汇报项目进度和计划行为 — 需要集成测试

## 3. 跨 session 状态共享机制

### 3.1 update_plan 同步
- [x] `codex-update-plan-tool.ts` 在成功后调用 `syncTeamStatusFromPlan()`
- [x] `syncTeamStatusFromPlan()` 计算 planSummary
- [x] `syncTeamStatusFromPlan()` 更新 team-status.json

### 3.2 PeriodicCheckRunner runtimeStatus 更新
- [x] `PeriodicCheckRunner.runOnce()` 获取 runtime_view
- [x] `PeriodicCheckRunner.runOnce()` 调用 `updateRuntimeStatus()`
- [x] 每 5 分钟更新一次

### 3.3 测试验证 ✅
- [x] `update_plan` 成功后，team.status 自动更新 — tests/unit/tools/team-status.test.ts: syncTeamStatusFromPlan
- [x] PeriodicCheckRunner 每 5 分钟更新 runtimeStatus — tests/integration/team-status.test.ts
- [x] team-status.json 持久化正确 — tests/integration/team-status.test.ts

## 4. Ledger 路径修复

### 4.1 normalizeRootDirForAgent
- [x] `normalizeRootDirForAgent()` 区分 system/project agent 的 sessions dir
- [x] System Agent 使用 `FINGER_PATHS.system.sessionsDir`
- [x] Project Agent 使用 `FINGER_PATHS.sessions.dir`

### 4.2 测试验证
- [ ] System Agent 的 ledger 文件在 `~/.finger/system/sessions` — 需要集成测试
- [ ] Project Agent 的 ledger 文件在 `~/.finger/sessions` — 需要集成测试
- [ ] `context_ledger.expand_task` 工具可以正确找到 ledger 文件 — 需要集成测试

## 5. Progress Monitor 集成

### 5.1 team.status 观测
- [x] `progress-monitor.impl.ts` 已集成 team.status 观测（Line 994）
- [x] Progress report 包含 team.status

### 5.2 测试验证
- [ ] Progress report 包含 team.status 信息 — 需要集成测试
- [ ] team.status 信息正确反映当前状态 — 需要集成测试

## 6. 综合测试场景

### 6.1 多 Agent 协作场景
- [ ] System Agent 可以看到所有 Project Agent 的状态 — 需要集成测试
- [ ] Project Agent 可以看到同 project 内的其他 agent 状态 — 需要集成测试
- [ ] Project Agent 可以看到 System Agent 的闲忙状态 — 需要集成测试

### 6.2 任务生命周期场景
- [ ] System Agent 派发任务后，team.status 更新 — 需要集成测试
- [ ] Project Agent 完成任务后，team.status 更新 — 需要集成测试
- [ ] 任务失败后，team.status 更新 — 需要集成测试

### 6.3 重启恢复场景
- [ ] Daemon 重启后，System Agent 自动恢复 — 需要集成测试
- [ ] System Agent 检查 team.status 并汇报 — 需要集成测试
- [ ] Project Agent 根据 registry.monitored 决定是否启动 — 需要集成测试

## 7. 测试状态总结

### ✅ 单元测试通过（17 tests）
- tests/unit/tools/team-status.test.ts: 11 tests passed
- tests/integration/team-status.test.ts: 6 tests passed

### 📋 待完成的集成测试
- System Agent 启动流程测试
- PeriodicCheckRunner runtimeStatus 更新测试
- Ledger 路径测试
- Progress Monitor 集成测试
- 多 Agent 协作场景测试
- 任务生命周期场景测试
- 重启恢复场景测试

## 8. 实现状态总结

### ✅ 已完成实现
1. team.status 工具设计完整（team-status-state.ts, team-status-tool.ts）
2. PeriodicCheckRunner runtimeStatus 更新机制
3. update_plan 同步机制（syncTeamStatusFromPlan）
4. Heartbeat prompt team.status 汇报
5. Progress monitor team.status 观测
6. Ledger 路径修复（normalizeRootDirForAgent）

### 📋 需要后续完成的集成测试
- 多 Agent 协作场景测试
- 任务生命周期场景测试
- 重启恢复场景测试
