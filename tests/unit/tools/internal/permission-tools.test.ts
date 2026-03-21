import { describe, it, expect, beforeEach } from 'vitest';
import { createToolExecutionContext } from '../../../../src/tools/internal/types.js';
import {
  permissionState,
  permissionCheckTool,
  permissionGrantTool,
  permissionDenyTool,
  permissionListTool,
} from '../../../../src/tools/internal/permission-tools.js';

const ctx = createToolExecutionContext();

describe('permission tools', () => {
  beforeEach(() => {
    permissionState.reset();
  });

  it('permission.check allows when mode=full', async () => {
    permissionState.setMode('full');
    const result = await permissionCheckTool.execute({ toolName: 'shell.exec' }, ctx);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it('permission.check requires approval in minimal mode', async () => {
    permissionState.setMode('minimal');
    const result = await permissionCheckTool.execute({ toolName: 'shell.exec', command: 'ls' }, ctx);
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
    expect(result.approvalId).toMatch(/^perm-/);
  });

  it('permission.check flags high-risk command in default mode', async () => {
    const result = await permissionCheckTool.execute({ toolName: 'shell.exec', command: 'rm -rf /tmp/test' }, ctx);
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
    expect(result.riskLevel).toBe('high');
  });

  it('permission.grant authorizes and allows subsequent check', async () => {
    const check = await permissionCheckTool.execute({ toolName: 'shell.exec', command: 'rm -rf /tmp/test' }, ctx);
    expect(check.requiresApproval).toBe(true);
    const grant = await permissionGrantTool.execute({ approvalId: check.approvalId, scope: 'turn' }, ctx);
    expect(grant.granted).toBe(true);
    const recheck = await permissionCheckTool.execute({ toolName: 'shell.exec', command: 'rm -rf /tmp/test' }, ctx);
    expect(recheck.allowed).toBe(true);
  });

  it('permission.deny returns suggestion and blocks execution', async () => {
    const check = await permissionCheckTool.execute({ toolName: 'shell.exec', command: 'rm -rf /tmp/test' }, ctx);
    const deny = await permissionDenyTool.execute({ approvalId: check.approvalId, reason: '拒绝' }, ctx);
    expect(deny.denied).toBe(true);
    expect(deny.suggestion).toContain('用户拒绝了 shell.exec');
  });

  it('permissions are isolated between different scopes', async () => {
    // Create approval in channel A scope
    const ctxA = createToolExecutionContext({ channelId: 'channel-qqbot' });
    const ctxB = createToolExecutionContext({ channelId: 'channel-webui' });

    const checkA = await permissionCheckTool.execute(
      { toolName: 'shell.exec', command: 'rm -rf /tmp/test' }, ctxA
    );
    expect(checkA.requiresApproval).toBe(true);
    expect(checkA.approvalId).toBeTruthy();

    // Same tool in channel B should also require approval (separate scope)
    const checkB = await permissionCheckTool.execute(
      { toolName: 'shell.exec', command: 'rm -rf /tmp/test' }, ctxB
    );
    expect(checkB.requiresApproval).toBe(true);
    expect(checkB.approvalId).toBeTruthy();
    expect(checkB.approvalId).not.toBe(checkA.approvalId);

    // Grant in channel A
    await permissionGrantTool.execute(
      { approvalId: checkA.approvalId, scope: 'session' }, ctxA
    );

    // Channel A should now allow
    const recheckA = await permissionCheckTool.execute(
      { toolName: 'shell.exec', command: 'rm -rf /tmp/test' }, ctxA
    );
    expect(recheckA.allowed).toBe(true);

    // Channel B should still require approval (not affected by A's grant)
    const recheckB = await permissionCheckTool.execute(
      { toolName: 'shell.exec', command: 'rm -rf /tmp/test' }, ctxB
    );
    expect(recheckB.allowed).toBe(false);
    expect(recheckB.requiresApproval).toBe(true);
  });

  it('scope falls back to sessionId when channelId is absent', async () => {
    const ctxSession = createToolExecutionContext({ sessionId: 'session-abc' });
    const check = await permissionCheckTool.execute(
      { toolName: 'shell.exec', command: 'rm -rf /tmp/test' }, ctxSession
    );
    expect(check.requiresApproval).toBe(true);

    // Grant via same session scope
    await permissionGrantTool.execute(
      { approvalId: check.approvalId, scope: 'session' }, ctxSession
    );

    const recheck = await permissionCheckTool.execute(
      { toolName: 'shell.exec' }, ctxSession
    );
    expect(recheck.allowed).toBe(true);
  });

  it('scope falls back to global when neither channelId nor sessionId is provided', async () => {
    const ctxGlobal = createToolExecutionContext();
    const check = await permissionCheckTool.execute(
      { toolName: 'shell.exec', command: 'rm -rf /tmp/test' }, ctxGlobal
    );
    expect(check.requiresApproval).toBe(true);
    expect(check.approvalId).toMatch(/^perm-/);
  });

  it('permission.list returns pending approvals and granted list', async () => {
    await permissionCheckTool.execute({ toolName: 'shell.exec', command: 'rm -rf /tmp/test' }, ctx);
    const list = await permissionListTool.execute({}, ctx);
    expect(list.pendingApprovals.length).toBe(1);
    expect(Array.isArray(list.grantedPermissions)).toBe(true);
  });
});
