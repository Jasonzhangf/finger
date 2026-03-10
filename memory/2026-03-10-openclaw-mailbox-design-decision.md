## OpenClaw Mailbox / Thread Binding 设计决策

日期: 2026-03-10
Tags: openclaw, mailbox, thread-binding, async-ingress, permissions, agent-runtime, design

### 已确认的边界
1. OpenClaw gate 保持通用，不为 finger 定制业务字段。
2. finger 自己实现 thread binding、权限策略、消息分类。
3. 控制渠道与非控制渠道分离：
   - 控制渠道可以在通过策略校验后进入 agent 主会话
   - 非控制渠道不直接驱动 agent，只能通过 mailbox 回流信息
4. 异步消息统一先进 mailbox，mailbox 是唯一真源。
5. agent 主对话不直接接收完整异步 payload，只接收 mailbox notice / mailbox snapshot。

### 已确认的 agent 接入方式
1. 如果 agent 正在 loop：
   - 新 mailbox item 到达时，只插入轻量 pending notice
   - agent 感知到有新 mailbox，再用 mailbox 工具主动读取
2. 每轮执行时：
   - 在工具调用后/构造下一轮请求前，runtime 拉取 mailbox delta 列表
   - 注入 mailbox snapshot block（来源/title/short description）
   - 模型如需要，再调用 mailbox.read 获取详情
3. mailbox.read 默认标记已读；ack 表示已处理完成。

### 建议优先级模型
- realtime: 立即产生 pending notice
- batched: 周期摘要提醒
- passive: 仅 mailbox 中可见，不主动提醒

### 后续设计任务
1. 设计 MailboxBlock schema
2. 设计 ThreadBindingBlock schema
3. 设计 runtime mailbox notice / snapshot 注入契约
4. 设计 OpenClaw ingress classifier
5. 设计逐步调试与验证基础
