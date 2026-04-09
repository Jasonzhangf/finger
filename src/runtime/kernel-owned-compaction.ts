export const RUST_KERNEL_COMPACTION_OWNERSHIP_MESSAGE =
  'Context compaction is Rust-kernel-owned; TypeScript compact/backfill paths have been removed.';

export function createRustKernelCompactionError(): Error {
  return new Error(RUST_KERNEL_COMPACTION_OWNERSHIP_MESSAGE);
}
