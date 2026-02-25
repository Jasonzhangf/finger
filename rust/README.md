# Finger Rust Kernel Workspace

This workspace contains the first migration slice of the non-UI agent loop kernel.

- `kernel-protocol`: shared Op/Event protocol contracts.
- `kernel-core`: minimal submission loop and task lifecycle runtime.
- `kernel-bridge-bin`: JSONL stdin/stdout bridge for integration with TypeScript orchestration.
