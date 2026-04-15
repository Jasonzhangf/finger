# Context History Management（Obsolete）

> Status: Obsolete
> Replaced by: `docs/design/context-rebuild-design.md`

本文件已废弃，不再作为 context rebuild / compact 的设计真源。

## 唯一有效文档

1. `docs/design/context-rebuild-design.md`

## 废弃原因

- 历史版本描述的是 **rebuild / compact 双流程**
- 当前实现已收敛为 **单一 rebuild core + 单一 runtime integration**
- 当前唯一实现目录是 `src/runtime/context-history/*`
- 当前唯一运行时消费快照是 `Session.messages`

## 执行规则

- 不得继续根据本文件新增或恢复旧实现
- 如需修改 rebuild 行为，只能更新 canonical 文档与 `src/runtime/context-history/*`
