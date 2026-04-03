function parseJsonRecord(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return typeof obj === 'object' && obj !== null ? obj as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function truncate(text: string, max = 60): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export function extractToolDetail(
  toolName: string,
  params?: string,
  result?: string,
): string {
  if (!params && !result) return '';

  if (toolName === 'update_plan') {
    const parsed = parseJsonRecord(params ?? '');
    const planItems = Array.isArray(parsed.plan) ? parsed.plan as Array<Record<string, unknown>> : [];
    if (planItems.length === 0) return '';
    const inProgress = planItems.find((item) => item.status === 'in_progress');
    if (inProgress && typeof inProgress.step === 'string') {
      return `▶ ${inProgress.step.trim()}`;
    }
    for (let i = planItems.length - 1; i >= 0; i -= 1) {
      const step = planItems[i];
      if (typeof step.step === 'string') {
        const statusIcon = step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '▶' : '○';
        return `${statusIcon} ${step.step.trim()}`;
      }
    }
    return '';
  }

  if (toolName === 'web_search' || toolName === 'search_query') {
    const parsed = parseJsonRecord(params ?? '');
    const query = typeof parsed.query === 'string' ? parsed.query.trim()
      : typeof parsed.q === 'string' ? parsed.q.trim()
      : '';
    return query ? `「${truncate(query, 50)}」` : '';
  }

  if (toolName === 'agent.dispatch' || toolName === 'dispatch') {
    const parsed = parseJsonRecord(params ?? '');
    const target = typeof parsed.target_agent_id === 'string' ? parsed.target_agent_id.trim()
      : typeof parsed.targetAgentId === 'string' ? parsed.targetAgentId.trim()
      : '';
    return target ? `→ ${target}` : '';
  }

  if (toolName === 'command.exec') {
    const parsed = parseJsonRecord(params ?? '');
    const raw = typeof parsed.input === 'string' ? parsed.input.trim() : '';
    return raw ? truncate(raw, 90) : '';
  }

  if (toolName === 'write_stdin') {
    const parsed = parseJsonRecord(params ?? '');
    const chars = typeof parsed.chars === 'string' ? parsed.chars.trim() : '';
    return chars ? `✍ ${truncate(chars, 80)}` : '';
  }

  if (toolName === 'view_image') {
    const parsed = parseJsonRecord(params ?? '');
    const path = typeof parsed.path === 'string' ? parsed.path.trim() : '';
    return path ? `🖼 ${truncate(path, 80)}` : '';
  }

  if (toolName === 'context_ledger.memory') {
    const parsed = parseJsonRecord(params ?? '');
    const action = typeof parsed.action === 'string' ? parsed.action.trim() : '';
    const query = typeof parsed.query === 'string' ? parsed.query.trim() : '';
    if (action && query) return `${action}: ${truncate(query, 50)}`;
    return action;
  }

  if (toolName === 'context_builder.rebuild') {
    const parsed = parseJsonRecord(params ?? '');
    const mode = typeof parsed.mode === 'string' ? parsed.mode.trim() : '';
    return mode ? `mode=${mode}` : '';
  }

  if (toolName === 'agent.deploy') {
    const parsed = parseJsonRecord(params ?? '');
    const id = typeof parsed.agentId === 'string' ? parsed.agentId.trim() : '';
    const role = typeof parsed.roleProfile === 'string' ? parsed.roleProfile.trim() : '';
    if (id && role) return `${id} (${role})`;
    return id || role || '';
  }

  if (toolName === 'agent.capabilities') {
    const parsed = parseJsonRecord(params ?? '');
    const id = typeof parsed.agentId === 'string' ? parsed.agentId.trim() : '';
    return id ? `agent=${id}` : '';
  }

  if (toolName === 'agent.control') {
    const parsed = parseJsonRecord(params ?? '');
    const action = typeof parsed.action === 'string' ? parsed.action.trim() : '';
    const id = typeof parsed.agentId === 'string' ? parsed.agentId.trim() : '';
    if (action && id) return `${action} ${id}`;
    return action || id || '';
  }

  if (toolName === 'agent.list') {
    const parsed = parseJsonRecord(params ?? '');
    const status = typeof parsed.status === 'string' ? parsed.status.trim() : '';
    return status ? `status=${status}` : '';
  }

  if (/^mailbox\./.test(toolName)) {
    const parsed = parseJsonRecord(params ?? '');
    const id = typeof parsed.message_id === 'string' ? parsed.message_id.trim() : '';
    return id ? `id=${id}` : '';
  }

  if (/^skills\./.test(toolName)) {
    const parsed = parseJsonRecord(params ?? '');
    const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    return name ? `name=${name}` : '';
  }

  return '';
}
