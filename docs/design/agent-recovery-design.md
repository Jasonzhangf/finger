# Agent Session Recovery Design

## 1. 任务状态机

```
PLANNING ──────────────────────────────────────┐
│                                              │
▼                                              │
HIGH_DESIGN ───────────────────────────────────┤
│                                              │
▼                                              │
DETAIL_DESIGN ─────────────────────────────────┤
│                                              │
▼                                              │
TASK_ALLOCATION ───────────────────────────────┤
│                                              │
▼                                              │
EXECUTION ─────────────────────────────────────┤
│ ├─ 非阻塞任务并行分配 (parallel)             │
│ └─ 阻塞任务强力攻关 (blocking)               │
│                                              │
▼                                              │
REVIEW ────────────────────────────────────────┤
│                                              │
▼                                              │
COMPLETED / FAILED ────────────────────────────┘
```

## 2. CHECKPOINT 触发点

- `reentry`: 会话重新进入时
- `task_failure`: 任务执行失败时
- `phase_change`: 阶段变更时（可选）
- `user_interrupt`: 用户中断时（可选）

## 3. 恢复流程

1. 加载保存的 session checkpoint
2. 运行初始 CHECKPOINT action 验证状态
3. 根据 checkpoint 状态决定是否回退阶段
4. 从恢复点继续执行

## 4. Agent 生命周期管理

- 使用 `scheduleDisconnect()` 延迟断开连接
- 使用 `ensureConnected()` 确保连接可用
- 任务执行后调用 `scheduleDisconnect()` 而非立即断开
- 模块销毁时彻底清理资源
