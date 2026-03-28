import type { ExecutionLifecycleState } from './execution-lifecycle.js';

export function getStartupReviewCheckpoint(lifecycle: ExecutionLifecycleState): string {
  const stableTaskId = [
    lifecycle.messageId,
    lifecycle.startedAt,
    lifecycle.turnId,
    lifecycle.dispatchId,
  ].find((value) => typeof value === 'string' && value.trim().length > 0) ?? 'no-task-id';

  return [
    'startup-review',
    lifecycle.finishReason ?? 'none',
    stableTaskId,
  ].join('::');
}

export function buildInterruptedExecutionResumePrompt(lifecycle: ExecutionLifecycleState): string {
  const lines = [
    '# Interrupted Execution Recovery',
    '',
    '系统刚刚重启。检测到你上一轮推理没有正常收口。',
    '你必须基于当前 session 历史与现有上下文，从中断处继续执行，而不是把它当成一个全新任务重新探索。',
    '',
    '## Recovery Snapshot',
    `- stage: ${lifecycle.stage}`,
    lifecycle.substage ? `- substage: ${lifecycle.substage}` : undefined,
    `- startedAt: ${lifecycle.startedAt}`,
    `- lastTransitionAt: ${lifecycle.lastTransitionAt}`,
    lifecycle.messageId ? `- messageId: ${lifecycle.messageId}` : undefined,
    lifecycle.dispatchId ? `- dispatchId: ${lifecycle.dispatchId}` : undefined,
    lifecycle.turnId ? `- turnId: ${lifecycle.turnId}` : undefined,
    lifecycle.toolName ? `- toolName: ${lifecycle.toolName}` : undefined,
    lifecycle.detail ? `- detail: ${lifecycle.detail}` : undefined,
    typeof lifecycle.retryCount === 'number' ? `- retryCount: ${lifecycle.retryCount}` : undefined,
    lifecycle.lastError ? `- lastError: ${lifecycle.lastError}` : undefined,
    '',
    '## Required Behavior',
    '1. 先检查最近一次未完成任务到底停在什么地方。',
    '2. 沿着原任务继续执行，优先完成闭环，不要从头做大范围重复探索。',
    '3. 如果你判断上次任务事实上已经完成，只是因为重启没有收口，那么立即输出总结并结束本轮。',
    '4. 如果恢复继续执行，请在正文里明确说明你是在“重启恢复后继续处理”。',
  ].filter((line): line is string => typeof line === 'string');

  return lines.join('\n');
}

export function buildCompletedExecutionReviewPrompt(lifecycle: ExecutionLifecycleState): string {
  const lines = [
    '# Startup Delivery Review',
    '',
    '系统刚刚重启。检测到上一轮执行已经以 finish_reason=stop 收口。',
    '你现在必须先审查“上一轮是否真的完成了用户目标”，而不是默认任务已经完成。',
    '',
    '## Review Snapshot',
    `- stage: ${lifecycle.stage}`,
    lifecycle.substage ? `- substage: ${lifecycle.substage}` : undefined,
    `- finishReason: ${lifecycle.finishReason ?? 'unknown'}`,
    `- startedAt: ${lifecycle.startedAt}`,
    `- lastTransitionAt: ${lifecycle.lastTransitionAt}`,
    lifecycle.messageId ? `- messageId: ${lifecycle.messageId}` : undefined,
    lifecycle.dispatchId ? `- dispatchId: ${lifecycle.dispatchId}` : undefined,
    lifecycle.turnId ? `- turnId: ${lifecycle.turnId}` : undefined,
    lifecycle.detail ? `- detail: ${lifecycle.detail}` : undefined,
    '',
    '## Required Behavior',
    '1. 先基于当前 session 历史核对上一轮用户目标、你的最终交付、以及是否真的闭环完成。',
    '2. 如果上一轮只是“停止”了，但目标没有真正完成、回复不充分、还有明显下一步可执行，必须立即继续执行，不要等待用户再次催促。',
    '3. 只有当用户目标已经完成，并且当前没有安全可做的下一步时，才允许结束本轮。',
    '4. 除非涉及危险/不可逆/需要权限确认的决定，否则不要等待用户输入；应在确认方案后自动继续执行。',
    '5. 在任何“准备等待”或“准备停止”之前，再检查一次原始目标：如果还有安全明确的下一步，就先做下一步。',
    '6. 心跳执行顺序必须固定：先完成上一轮任务；若只是伪完成，继续做到真完成；真完成后才允许查看 heartbeat 文件。',
    '',
    '如果你判断上一轮已经完成，请输出最小化内部确认并结束；如果未完成，直接继续完成闭环。',
  ].filter((line): line is string => typeof line === 'string');

  return lines.join('\n');
}
