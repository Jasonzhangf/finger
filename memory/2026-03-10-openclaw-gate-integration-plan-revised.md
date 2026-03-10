# OpenClaw Gate 接入计划（基于 Finger 现有架构修订版）
## 当前架构探索
### 核心架构（三层架构）
1. **blocks**（基础能力层）：唯一真源，提供基础能力
2. **orchestration**（编排层）：只做 block 的组合与调度
3. **ui**（呈现层）：只负责展示与交互
### Daemon 配置系统
- **配置位置**：`~/.finger/config/{inputs,outputs,routes}.yaml`
- **配置加载**：`src/core/config-loader.ts`
  - `inputs.yaml`：输入源定义（stdin/timer）
  - `outputs.yaml`：输出目标定义（exec/file）
  - `routes.yaml`：路由规则
### 消息模型（src/core/schema.ts）
```typescript
interface Message {
  version: "v1";
  type: string;
  payload: unknown;
  meta: {
    id: string;
    timestamp: number;
    source: string;
    dest?: string;
    traceId?: string;
  };
}
```
## 接入计划
### 阶段 1：基础接入（基础能力层）
#### 1.1 添加 OpenClaw Gate Block
- **位置**：`src/blocks/openclaw-gate/`
- **功能**：
  - 实现 OpenClaw Gate v1.0 协议兼容层
  - 提供插件管理基础能力（安装/卸载/启停）
  - 实现沙箱隔离机制
  - 集成到 Finger 消息模型
#### 1.2 更新配置 Schema
- **位置**：`src/core/schema.ts`
- **功能**：
  - 添加 `openclaw` 输入类型
  - 添加 `openclaw` 输出类型
  - 更新配置加载器以支持新类型
#### 1.3 配置加载集成
- **位置**：`src/core/config-loader.ts`
- **功能**：
  - `loadInputsConfig()` 支持 `openclaw` 输入
  - `loadOutputsConfig()` 支持 `openclaw` 输出
  - 配置解析和验证
### 阶段 2：编排层集成
#### 2.1 插件工具注册
- **位置**：`src/orchestration/openclaw-adapter/`
- **功能**：
  - 动态发现和注册 OpenClaw 插件工具
  - 工具调用的协议转换（Finger Message ↔ OpenClaw 协议）
  - 错误处理和重试机制
#### 2.2 Agent 能力扩展
- **位置**：`src/agents/core/openclaw-extension/`
- **功能**：
  - Agent 动态加载插件工具
  - 插件权限动态授予
  - 插件调用上下文传递
#### 2.3 事件系统集成
- **位置**：`src/runtime/events/openclaw/`
- **功能**：
  - 插件事件转发和处理
  - 事件审计和日志
  - Webhook 通知（可选）
### 阶段 3：UI 接入
#### 3.1 插件市场界面
- **位置**：`ui/src/pages/PluginMarket/`
- **功能**：
  - 插件浏览和搜索
  - 插件详情展示
  - 一键安装/卸载
  - 插件评分和评价
#### 3.2 插件管理界面
- **位置**：`ui/src/pages/PluginManager/`
- **功能**：
  - 已安装插件列表
  - 插件配置界面
  - 运行状态监控
  - 日志查看
### 阶段 4：测试和上线
- 兼容性测试
- 安全评估
- 性能测试
- 文档编写
- 灰度发布
## 技术架构设计
```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   OpenClaw      │────▶│   Block Layer   │────▶│   Hub Core      │
│   Plugins       │     │   (OpenClaw)    │     │   (Message)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
          ▲                        ▲                        ▲
          │                        │                        │
          ▼                        ▼                        ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   UI Interface  │     │   Orchestration │     │   Agent Runtime │
│   (Market/Admin)│     │   Layer         │     │   (Tool Calling)│
└─────────────────┘     └─────────────────┘     └─────────────────┘
```
## 关键设计决策
1. **Blocks 优先**：所有 OpenClaw 功能下沉到 blocks 层作为基础能力
2. **配置驱动**：通过标准的 inputs/outputs/routes 配置进行管理
3. **消息兼容**：完全复用 Finger 的 Message 模型
4. **三层解耦**：保持严格的三层架构分离
5. **最小权限**：插件默认最小权限集
## 验收标准
- ✅ OpenClaw 插件可以通过标准 inputs.yaml 配置接入
- ✅ 插件工具可以被 Agent 正常调用
- ✅ 插件运行在沙箱中，无法访问未授权资源
- ✅ 插件市场和管理界面功能完整
- ✅ 所有调用都有完整的审计日志
