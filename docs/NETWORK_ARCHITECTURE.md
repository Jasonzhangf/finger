# 网络架构设计：联网对战与人机对战

## 1. 概述

本文档定义 Finger 项目的联网对战和人机对战的通信协议、状态同步机制、匹配系统设计。

### 1.1 设计目标

- **低延迟**：状态同步延迟 < 100ms（局域网）/ < 200ms（公网）
- **公平性**：防止作弊，确保所有客户端状态一致
- **可扩展**：支持 1v1、多人混战、人机对战等多种模式
- **容错性**：网络波动时自动恢复，断线重连

---

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Game Client (Browser)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ GameEngine   │  │ StateSync    │  │ InputManager │  │ UIManager   │ │
│  │ (本地逻辑)   │  │ (状态同步)   │  │ (输入预测)   │  │ (渲染)      │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────────────┘ │
│         │                 │                  │                          │
│         └─────────────────┼──────────────────┘                          │
│                           │                                             │
│                    ┌──────▼──────┐                                      │
│                    │ GameClient  │                                      │
│                    │ (WebSocket) │                                      │
│                    └──────┬──────┘                                      │
└───────────────────────────┼─────────────────────────────────────────────┘
                            │ WebSocket (ws://host:8082)
                            │
┌───────────────────────────┼─────────────────────────────────────────────┐
│                    Game Server                                            │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                    GameWebSocketServer (Port 8082)                  │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                           │                                              │
│         ┌─────────────────┼─────────────────┬─────────────────┐         │
│         ▼                 ▼                 ▼                 ▼         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │ MatchMaker  │  │ RoomManager │  │ StateSync   │  │ AIPlayer    │    │
│  │ (匹配系统)  │  │ (房间管理)  │  │ (状态同步)  │  │ (AI 玩家)   │    │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘    │
│         │                │                │                │           │
│         └────────────────┼────────────────┴────────────────┘           │
│                          │                                              │
│                   ┌──────▼──────┐                                       │
│                   │ GameManager │                                       │
│                   │ (游戏逻辑)  │                                       │
│                   └─────────────┘                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 核心概念

### 3.1 实体定义

```typescript
// src/game/types.ts

/** 玩家 */
interface Player {
  id: string;              // 唯一标识
  name: string;            // 显示名称
  type: 'human' | 'ai';    // 玩家类型
  rating: number;          // 匹配积分 (ELO)
  connection: 'online' | 'offline' | 'reconnecting';
}

/** 房间 */
interface Room {
  id: string;
  type: 'pvp' | 'pve' | 'custom';
  status: 'waiting' | 'playing' | 'paused' | 'finished';
  players: Map<string, PlayerState>;
  spectators: Set<string>;
  config: GameConfig;
  createdAt: number;
}

/** 玩家游戏状态 */
interface PlayerState {
  playerId: string;
  // 马里奥游戏特有状态
  position: { x: number; y: number };
  velocity: { vx: number; vy: number };
  facing: 1 | -1;
  onGround: boolean;
  score: number;
  coins: number;
  lives: number;
  // 网络状态
  lastInputSeq: number;
  ping: number;
}

/** 游戏配置 */
interface GameConfig {
  mode: 'race' | 'battle' | 'coop';  // 竞速/对战/合作
  mapId: string;
  timeLimit: number;      // 秒
  powerups: boolean;
  friendlyFire: boolean;
}

/** 输入帧 */
interface InputFrame {
  seq: number;            // 序列号
  timestamp: number;      // 客户端时间戳
  inputs: {
    left: boolean;
    right: boolean;
    jump: boolean;
    action: boolean;
  };
}
```

---

## 4. 通信协议

### 4.1 WebSocket 消息格式

```typescript
// 所有消息的基础格式
interface GameMessage<T = unknown> {
  type: string;           // 消息类型
  seq?: number;           // 序列号（用于确认）
  timestamp: number;      // 发送时间戳
  payload: T;
}
```

### 4.2 消息类型定义

#### 4.2.1 连接与认证

```typescript
// 客户端 -> 服务端：加入游戏
interface JoinRequest {
  type: 'join';
  payload: {
    playerId: string;
    token: string;        // 认证令牌
    gameType: 'pvp' | 'pve' | 'custom';
    preferences?: {
      mapId?: string;
      mode?: 'race' | 'battle' | 'coop';
    };
  };
}

// 服务端 -> 客户端：加入结果
interface JoinResponse {
  type: 'join_result';
  payload: {
    success: boolean;
    roomId?: string;
    error?: string;
    waitTime?: number;    // 预计等待时间（秒）
  };
}
```

#### 4.2.2 匹配系统

```typescript
// 服务端 -> 客户端：匹配状态更新
interface MatchUpdate {
  type: 'match_update';
  payload: {
    status: 'searching' | 'found' | 'cancelled';
    playersFound: number;
    playersNeeded: number;
    estimatedWait: number;
  };
}

// 客户端 -> 服务端：取消匹配
interface CancelMatch {
  type: 'cancel_match';
  payload: {};
}
```

#### 4.2.3 房间管理

```typescript
// 服务端 -> 客户端：房间状态
interface RoomState {
  type: 'room_state';
  payload: {
    room: Room;
    players: PlayerState[];
    countdown?: number;   // 开始倒计时
  };
}

// 客户端 -> 服务端：准备/取消准备
interface ReadyToggle {
  type: 'ready';
  payload: {
    ready: boolean;
  };
}

// 服务端 -> 客户端：游戏开始
interface GameStart {
  type: 'game_start';
  payload: {
    seed: number;         // 随机种子（用于同步地图元素）
    startTime: number;    // 服务器时间戳
    initialStates: Map<string, PlayerState>;
  };
}
```

#### 4.2.4 游戏状态同步

```typescript
// 客户端 -> 服务端：输入上报
interface InputReport {
  type: 'input';
  payload: {
    frames: InputFrame[]; // 可批量上报
  };
}

// 服务端 -> 客户端：状态快照
interface StateSnapshot {
  type: 'snapshot';
  payload: {
    frame: number;        // 游戏帧号
    timestamp: number;    // 服务器时间戳
    players: Map<string, PlayerState>;
    events?: GameEvent[]; // 特殊事件（得分、死亡等）
  };
}

// 服务端 -> 客户端：增量状态更新
interface StateDelta {
  type: 'delta';
  payload: {
    frame: number;
    timestamp: number;
    delta: Partial<PlayerState>[];  // 只包含变化的部分
  };
}
```

#### 4.2.5 游戏事件

```typescript
interface GameEvent {
  type: 'score' | 'death' | 'powerup' | 'checkpoint' | 'finish';
  playerId: string;
  data: Record<string, unknown>;
}

// 服务端 -> 客户端：游戏事件广播
interface GameEventBroadcast {
  type: 'game_event';
  payload: GameEvent;
}
```

#### 4.2.6 断线重连

```typescript
// 客户端 -> 服务端：重连请求
interface ReconnectRequest {
  type: 'reconnect';
  payload: {
    playerId: string;
    roomId: string;
    token: string;
    lastFrame: number;    // 客户端最后的帧号
  };
}

// 服务端 -> 客户端：重连响应
interface ReconnectResponse {
  type: 'reconnect_result';
  payload: {
    success: boolean;
    currentState?: StateSnapshot;
    missedEvents?: GameEvent[];
  };
}
```

---

## 5. 状态同步机制

### 5.1 确定性帧同步 (Deterministic Lockstep)

适用于马里奥类游戏的精确同步：

```
客户端流程：
1. 收集本地输入 → 生成 InputFrame
2. 发送 InputReport 到服务器
3. 接收其他玩家的输入（从服务器）
4. 等待所有玩家输入到达（或超时）
5. 执行一帧游戏逻辑
6. 渲染

服务器流程：
1. 收集所有玩家输入
2. 广播聚合输入给所有客户端
3. （可选）验证游戏状态防止作弊
```

### 5.2 状态快照 + 增量更新

```typescript
// 同步策略
class StateSynchronizer {
  // 快照间隔：每 60 帧（约 1 秒）发送完整快照
  private SNAPSHOT_INTERVAL = 60;
  
  // 增量更新：每 3 帧（约 50ms）发送增量
  private DELTA_INTERVAL = 3;
  
  // 客户端缓冲：存储最近 N 帧用于回滚
  private stateBuffer: Deque<GameState>;
  
  // 客户端预测：本地输入立即执行
  predictLocalInput(input: InputFrame): void;
  
  // 服务器校验：收到服务器状态后进行修正
  reconcile(serverState: PlayerState): void;
}
```

### 5.3 客户端预测与服务端校验

```typescript
// 客户端预测
class ClientPredictor {
  private pendingInputs: InputFrame[] = [];
  
  onLocalInput(input: InputFrame): void {
    // 1. 立即执行预测
    this.applyInput(input);
    
    // 2. 存储等待确认
    this.pendingInputs.push(input);
  }
  
  onServerState(state: PlayerState, lastSeq: number): void {
    // 3. 服务器确认后，重新应用未确认的输入
    this.rollbackTo(state);
    
    const unconfirmed = this.pendingInputs.filter(i => i.seq > lastSeq);
    for (const input of unconfirmed) {
      this.applyInput(input);
    }
    
    this.pendingInputs = unconfirmed;
  }
}
```

### 5.4 延迟补偿

```typescript
// 服务器端延迟补偿
class LagCompensator {
  // 存储玩家历史状态
  private stateHistory: Map<string, PlayerStateSnapshot[]>;
  
  // 当玩家 A 的攻击事件到达时
  // 回退到玩家 A 发送该输入时的世界状态
  // 判定攻击是否命中
  validateHit(attacker: string, target: string, attackFrame: number): boolean {
    const attackerPing = this.getPing(attacker);
    const rewindTime = attackFrame - attackerPing / 2;
    
    const historicalState = this.getStateAtFrame(target, rewindTime);
    // 基于历史状态判定
    return this.checkCollision(attack, historicalState);
  }
}
```

---

## 6. 匹配机制

### 6.1 匹配流程

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Match Flow                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Player A                     Server                     Player B    │
│     │                          │                            │        │
│     │──── join(pvp) ──────────►│                            │        │
│     │                          │◄────── join(pvp) ─────────│        │
│     │                          │                            │        │
│     │                          │ [Match Queue]              │        │
│     │                          │ - Player A (rating: 1500)  │        │
│     │                          │ - Player B (rating: 1510)  │        │
│     │                          │                            │        │
│     │                          │ [Rating Range: ±100]       │        │
│     │                          │ ✓ Match Found!             │        │
│     │                          │                            │        │
│     │◄─── match_found ─────────│─────────────────────────►│        │
│     │                          │                            │        │
│     │─── ready(true) ─────────►│◄──── ready(true) ─────────│        │
│     │                          │                            │        │
│     │                          │ [Countdown: 3s]            │        │
│     │                          │                            │        │
│     │◄─── game_start ──────────│─────────────────────────►│        │
│     │                          │                            │        │
└─────────────────────────────────────────────────────────────────────┘
```

### 6.2 匹配算法

```typescript
class MatchMaker {
  private queue: MatchQueue;
  private readonly RATING_RANGE = 100;   // 初始匹配范围
  private readonly RANGE_EXPANSION = 50; // 每秒扩展范围
  private readonly MAX_RANGE = 500;      // 最大范围
  
  async findMatch(player: Player): Promise<Room> {
    const entry: QueueEntry = {
      player,
      joinedAt: Date.now(),
      ratingRange: this.RATING_RANGE,
    };
    
    this.queue.add(entry);
    
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        // 尝试匹配
        const match = this.tryMatch(entry);
        if (match) {
          clearInterval(checkInterval);
          this.queue.remove(entry);
          resolve(match);
          return;
        }
        
        // 扩大搜索范围
        entry.ratingRange = Math.min(
          entry.ratingRange + this.RANGE_EXPANSION,
          this.MAX_RANGE
        );
      }, 1000);
    });
  }
  
  private tryMatch(entry: QueueEntry): Room | null {
    const candidates = this.queue.findCandidates(
      entry.player.rating,
      entry.ratingRange
    );
    
    if (candidates.length >= 1) {
      // 创建房间
      return this.createRoom([entry.player, candidates[0].player]);
    }
    
    return null;
  }
}
```

### 6.3 人机匹配

```typescript
class AIPlayer implements Player {
  type: 'ai' = 'ai';
  
  // AI 难度等级
  difficulty: 'easy' | 'normal' | 'hard';
  
  // 根据玩家 rating 自动调整难度
  adjustDifficulty(playerRating: number): void {
    if (playerRating < 1200) {
      this.difficulty = 'easy';
    } else if (playerRating < 1600) {
      this.difficulty = 'normal';
    } else {
      this.difficulty = 'hard';
    }
  }
  
  // 生成输入（由 AI 逻辑决定）
  generateInput(gameState: GameState): InputFrame {
    // 根据 AI 难度和游戏状态生成合理的输入
    // 简单 AI：随机输入 + 基础避障
    // 普通 AI：寻路 + 简单策略
    // 困难 AI：高级策略 + 预测玩家行为
  }
}
```

---

## 7. 协议时序图

### 7.1 完整游戏流程

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Full Game Lifecycle                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  Client A                     Server                     Client B             │
│     │                          │                            │                 │
│     │──── ws.connect ─────────►│                            │                 │
│     │◄─── connected ───────────│                            │                 │
│     │                          │◄────── ws.connect ─────────│                 │
│     │                          │─────── connected ─────────►│                 │
│     │                          │                            │                 │
│     │──── join(pvp) ──────────►│                            │                 │
│     │                          │◄────── join(pvp) ─────────│                 │
│     │                          │                            │                 │
│     │◄─── match_found ─────────│─────── match_found ───────►│                 │
│     │                          │                            │                 │
│     │──── ready ──────────────►│◄────── ready ─────────────│                 │
│     │                          │                            │                 │
│     │◄─── game_start ──────────│─────── game_start ────────►│                 │
│     │     (seed, startTime)    │     (seed, startTime)      │                 │
│     │                          │                            │                 │
│     │──────────────────────────│────────────────────────────│                 │
│     │         Game Loop (每帧/每 N 帧)                        │                 │
│     │──────────────────────────│────────────────────────────│                 │
│     │                          │                            │                 │
│     │──── input(seq=1) ───────►│                            │                 │
│     │──── input(seq=2) ───────►│◄────── input(seq=1) ───────│                 │
│     │                          │─────── input(seq=2) ──────►│                 │
│     │                          │                            │                 │
│     │◄─── snapshot ────────────│─────── snapshot ──────────►│                 │
│     │    (aggregated inputs)   │    (aggregated inputs)     │                 │
│     │                          │                            │                 │
│     │    ... (重复直到游戏结束)  │                            │                 │
│     │                          │                            │                 │
│     │◄─── game_event(finish) ──│─────── game_event ────────►│                 │
│     │                          │                            │                 │
│     │◄─── room_state(finished) │─────── room_state ────────►│                 │
│     │                          │                            │                 │
│     │──── leave ──────────────►│◄────── leave ─────────────│                 │
│     │                          │                            │                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 8. 错误处理与恢复

### 8.1 网络异常

```typescript
// 心跳检测
class HeartbeatManager {
  private interval = 5000;  // 5秒心跳
  private timeout = 15000;  // 15秒超时
  
  start(): void {
    this.sendPing();
    this.timer = setInterval(() => this.sendPing(), this.interval);
  }
  
  private sendPing(): void {
    this.ws.send({ type: 'ping', timestamp: Date.now() });
    this.checkTimeout();
  }
  
  private checkTimeout(): void {
    if (Date.now() - this.lastPong > this.timeout) {
      this.emit('disconnect');
    }
  }
}
```

### 8.2 断线重连

```typescript
class ReconnectionHandler {
  private maxRetries = 5;
  private retryDelay = 1000;
  
  async reconnect(roomId: string): Promise<boolean> {
    for (let i = 0; i < this.maxRetries; i++) {
      try {
        const ws = await this.connect();
        
        const response = await this.sendReconnect(ws, roomId);
        
        if (response.success) {
          // 同步状态
          this.syncState(response.currentState);
          this.replayMissedEvents(response.missedEvents);
          return true;
        }
      } catch (err) {
        await sleep(this.retryDelay * (i + 1));
      }
    }
    
    return false;
  }
}
```

---

## 9. 安全考虑

### 9.1 防作弊措施

| 威胁 | 防御措施 |
|------|---------|
| 修改客户端数据 | 服务端验证所有关键状态变更 |
| 加速器/减速器 | 服务端控制游戏速度，验证帧时间 |
| 透视/自瞄 | 服务端计算碰撞，不信任客户端判定 |
| 注入假输入 | 序列号连续性检查，异常输入检测 |

### 9.2 输入验证

```typescript
class InputValidator {
  // 检查输入序列是否连续
  validateSequence(inputs: InputFrame[], lastSeq: number): boolean {
    for (const input of inputs) {
      if (input.seq !== lastSeq + 1) {
        return false;  // 序列不连续
      }
      lastSeq = input.seq;
    }
    return true;
  }
  
  // 检查输入是否合法
  validateInput(input: InputFrame): boolean {
    // 检查时间戳是否合理（不能来自未来）
    if (input.timestamp > Date.now() + 1000) return false;
    
    // 检查输入频率是否异常
    if (this.getRecentInputRate() > 100) return false;  // 超过 100 Hz
    
    return true;
  }
}
```

---

## 10. 性能指标

### 10.1 目标指标

| 指标 | 目标值 | 测量方法 |
|------|--------|---------|
| 端到端延迟 | < 100ms (LAN) / < 200ms (WAN) | Ping 统计 |
| 状态同步频率 | 20 Hz (每 50ms) | 帧率监控 |
| 快照间隔 | 1 Hz (每秒) | 计数器 |
| 断线重连时间 | < 3s | 计时器 |
| 匹配时间 | < 30s (90% 场景) | 队列时间统计 |

### 10.2 监控指标

```typescript
interface NetworkMetrics {
  // 延迟
  ping: { min: number; max: number; avg: number; p95: number };
  
  // 丢包
  packetLoss: number;  // 百分比
  
  // 同步
  syncDelay: number;   // 客户端与服务器状态差异（帧数）
  
  // 预测准确率
  predictionAccuracy: number;  // 百分比
}
```

---

## 11. 实现路线图

### Phase 1: 基础框架 (Week 1-2)

- [ ] 实现 GameWebSocketServer
- [ ] 定义完整消息类型
- [ ] 实现基础房间管理

### Phase 2: 状态同步 (Week 3-4)

- [ ] 实现输入同步
- [ ] 实现状态快照
- [ ] 实现客户端预测

### Phase 3: 匹配系统 (Week 5-6)

- [ ] 实现匹配队列
- [ ] 实现 ELO 积分系统
- [ ] 实现 AI 玩家

### Phase 4: 容错与安全 (Week 7-8)

- [ ] 实现断线重连
- [ ] 实现延迟补偿
- [ ] 实现防作弊检测

---

## 附录 A: 消息类型汇总

| 类型 | 方向 | 说明 |
|------|------|------|
| `join` | C→S | 加入游戏 |
| `join_result` | S→C | 加入结果 |
| `match_update` | S→C | 匹配状态更新 |
| `cancel_match` | C→S | 取消匹配 |
| `room_state` | S→C | 房间状态 |
| `ready` | C→S | 准备/取消准备 |
| `game_start` | S→C | 游戏开始 |
| `input` | C→S | 输入上报 |
| `snapshot` | S→C | 状态快照 |
| `delta` | S→C | 增量更新 |
| `game_event` | S→C | 游戏事件广播 |
| `reconnect` | C→S | 重连请求 |
| `reconnect_result` | S→C | 重连结果 |
| `ping` | C→S | 心跳请求 |
| `pong` | S→C | 心跳响应 |
| `leave` | C→S | 离开房间 |

---

## 附录 B: 与现有架构集成

本设计可复用 Finger 项目现有组件：

| 现有组件 | 复用方式 |
|---------|---------|
| `WebSocketBlock` | 扩展为 `GameWebSocketBlock`，增加游戏协议支持 |
| `MessageHub` | 用于游戏服务器内部模块间通信 |
| `SessionManager` | 扩展为 `GameSessionManager`，增加玩家状态管理 |
| `EventBus` | 用于游戏事件广播 |

新增组件：

| 组件 | 路径 | 说明 |
|------|------|------|
| `GameServer` | `src/game/server/index.ts` | 游戏服务器入口 |
| `MatchMaker` | `src/game/match/matcher.ts` | 匹配逻辑 |
| `RoomManager` | `src/game/room/manager.ts` | 房间管理 |
| `StateSync` | `src/game/sync/synchronizer.ts` | 状态同步 |
| `AIPlayer` | `src/game/ai/player.ts` | AI 玩家 |

---

> 本文档为设计文档，具体实现需根据实际需求调整。
