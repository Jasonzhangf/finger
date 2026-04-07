# System Agent V3 设计文档

> **Epic**: finger-247 (V3 简化版)
> **创建时间**: 2026-03-21 (V2), 2026-04-07 (V3)
> **状态**: 实施中

## 概述

System Agent V3 是 Finger 系统的核心代理，精简为 **单一身份**：

**Manager + Reviewer = Orchestrator**

1. 用户请求的理解、规划和派发
2. **审核 Project Agent 的完成声明**
3. 系统级任务的执行
4. 记忆管理和用户画像维护
5. 多通道消息同步

**V3 核心变化（2026-04-07）**：
- 去掉独立 Reviewer Agent，审核职责合并到 System Agent
- 去掉冗余角色（user-interaction、agent-coordination、task-dispatcher、task-reporter、mailbox-handler）
- System Agent 只有一个身份：**Orchestrator**
- 新增 `project.review_claim` 工具职责

---

## 一、单一身份：Orchestrator

### 1.1 核心闭环

```text
用户请求 → 理解规划 → 派发 → 监控 → 审核 → 验收 → 汇报
```

**派发阶段**：
- 项目路径任务必须委派给 Project Agent（强制）
- 调用 `agent.dispatch`，记录 taskId
- 进入监控模式

**审核阶段（NEW）**：
- 接收 Project Agent 的 `project.claim_completion`
- 检查证据：changedFiles、verification、acceptanceChecklist
- 决策：PASS → approve；REJECT → feedback for rework

**验收阶段**：
- PASS → 调用 `project.approve_task(taskId)`
- 向用户汇报最终结果（简洁、过滤中间废话）

### 1.2 禁止事项

- 禁止直接执行代码变更（由 Project Agent 负责）
- 禁止未经审核直接转发 Project Agent 结果给用户
- 禁止跳过 claim 审核环节
- 禁止扮演"传声筒"，必须主动审计证据

---

## 二、请求分类与派发

### 2.1 分类逻辑

```typescript
interface RequestClassification {
  type: 'simple' | 'project' | 'system';
  targetPath?: string;
  projectId?: string;
}

function classifyRequest(input: string): RequestClassification {
  const pathMatch = extractPath(input);
  if (pathMatch) {
    if (isSystemPath(pathMatch)) return { type: 'system', targetPath: pathMatch };
    if (isProjectPath(pathMatch)) return { type: 'project', targetPath: pathMatch };
  }
  if (input.length < 50 && !hasComplexGoal(input)) {
    return { type: 'simple' };
  }
  return { type: 'project' }; // 默认委派
}
```

### 2.2 派发流程

```
用户请求
    │
    ▼
┌─────────────────────────────────────────────┐
│           请求类型判断                       │
├─────────────────────────────────────────────┤
│ 1. 简洁请求 → 直接回答                       │
│ 2. 项目操作 → 委派 Project Agent            │
│ 3. 系统操作 → System Agent 直接执行         │
└─────────────────────────────────────────────┘
    │
    ├─── 简洁请求 ──▶ 直接回答
    │
    ├─── 项目操作 ──▶ agent.dispatch → 监控 → 审核 → 汇报
    │
    └─── 系统操作 ──▶ 直接执行（需授权）
```

---

## 三、审核流程（新增核心）

### 3.1 收到 claim_completion 后的动作

```typescript
async function handleClaimCompletion(claim: CompletionClaim): Promise<void> {
  // 1. 验证 claim 结构完整性
  if (!claim.taskId || !claim.summary || !claim.changedFiles) {
    return rejectClaim(claim.taskId, '缺少必要字段：taskId/summary/changedFiles');
  }

  // 2. 验证 verification 结果
  if (claim.verification.status !== 'pass') {
    return rejectClaim(claim.taskId, '验证未通过，请先修复问题');
  }

  // 3. 验收 checklist
  const unmet = claim.acceptanceChecklist.filter(c => c.status !== 'met');
  if (unmet.length > 0) {
    return rejectClaim(claim.taskId, `验收项未满足：${unmet.map(c => c.criterion).join(', ')}`);
  }

  // 4. PASS → approve
  await approveTask(claim.taskId);
  await reportToUser(claim.summary, claim.changedFiles, claim.verification);
}
```

### 3.2 Review Decision Schema

```typescript
interface ReviewDecision {
  taskId: string;
  decision: 'PASS' | 'REJECT';
  evidenceCheck: {
    changedFilesVerified: boolean;
    verificationPassed: boolean;
    acceptanceCriteriaMet: boolean;
  };
  feedback?: string;
  missingItems?: string[];
  reviewedAt: string;
}
```

---

## 四、用户画像 & 记忆管理

### 4.1 文件结构

```
~/.finger/system/
├── USER.md           # 用户画像
├── MEMORY.md         # 长期记忆
├── CACHE.md          # 短期对话缓存
└── SOUL.md           # 回答风格偏好
```

### 4.2 启动时加载

```typescript
async function loadUserProfile(): Promise<UserProfile> {
  const userMd = await readFile(USER_MD_PATH, 'utf-8').catch(() => '');
  const memoryMd = await readFile(MEMORY_MD_PATH, 'utf-8').catch(() => '');
  return { profile: parseUserMd(userMd), memories: parseMemoryMd(memoryMd) };
}
```

---

## 五、Heartbeat & Mailbox

### 5.1 定时检查流程

```typescript
async function tick(): Promise<void> {
  // 1. 检查未审核的 claim
  const pendingClaims = await listPendingClaims();
  for (const claim of pendingClaims) {
    if (claim.age > CLAIM_TIMEOUT) {
      await handleClaimCompletion(claim);
    }
  }

  // 2. 检查 stalled 任务
  const stalledTasks = await listStalledTasks();
  for (const task of stalledTasks) {
    await recoveryDispatch(task);
  }
}
```

---

## 六、工具清单

| 工具名 | 所有者 | 职责 |
|--------|--------|------|
| `agent.dispatch` | System Agent | 派发任务给 Project Agent |
| `project.task.status` | System Agent | 查询任务状态 |
| `project.review_claim` | System Agent | 审核 claim + evidence |
| `project.approve_task` | System Agent | 验收通过 |
| `project.reject_task` | System Agent | 拒绝，要求重做 |
| `project.claim_completion` | Project Agent | 提交完成声明 |

---

## 七、验收标准

### 核心闭环验证
- [ ] System Agent 派发任务后进入监控模式
- [ ] 收到 claim_completion 后执行审核逻辑
- [ ] PASS → approve 并汇报用户
- [ ] REJECT → 反馈具体问题，Project Agent 重做

### 反模式检测
- [ ] System Agent 不跳过审核直接转发结果
- [ ] System Agent 不重复执行已派发的任务
- [ ] Project Agent 不提交无 evidence 的 claim

---

## 八、总结

| Item | V2 (Old) | V3 (New) |
|------|----------|----------|
| Roles | 多角色切换（user-interaction、agent-coordination 等） | 单一身份：Orchestrator |
| Reviewer | 独立 Reviewer Agent | 合并到 System Agent |
| Claim Contract | 自由格式 | 结构化 schema |
| Review Flow | Reviewer → System | System Agent 自己审核 |
