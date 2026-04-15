export interface ToolCompatSpecLike {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const SPEC_SAFE_ALIAS_GROUPS = [
  ['command.exec', 'command_exec', 'exec_command'],
  ['user.ask', 'user_ask'],
  ['agent.list', 'agent_list'],
  ['agent.dispatch', 'agent_dispatch'],
  ['agent.query', 'agent_query'],
  ['agent.progress.ask', 'agent_progress_ask'],
  ['agent.capabilities', 'agent_capabilities'],
  ['agent.control', 'agent_control'],
  ['project.task.status', 'project_task_status'],
  ['project.task.update', 'project_task_update'],
  ['context_ledger.memory', 'context_ledger_memory'],
  ['context_ledger.expand_task', 'context_ledger_expand_task'],
  ['context_history.rebuild', 'context_history_rebuild'],
  ['mailbox.status', 'mailbox_status'],
  ['mailbox.list', 'mailbox_list'],
  ['mailbox.read', 'mailbox_read'],
  ['mailbox.read_all', 'mailbox_read_all'],
  ['mailbox.ack', 'mailbox_ack'],
  ['mailbox.remove', 'mailbox_remove'],
  ['mailbox.remove_all', 'mailbox_remove_all'],
  ['reasoning.stop', 'reasoning_stop'],
  ['reasoning.stop_policy', 'reasoning_stop_policy'],
  ['skills.list', 'skills_list'],
  ['context_ledger.digest', 'context_ledger_digest'],
  ['skills.status', 'skills_status'],
  ['update_plan', 'update-plan', 'update.plan'],
  ['system-registry-tool', 'system_registry_tool'],
  ['heartbeat.status', 'heartbeat_status'],
] as const;

const RESOLUTION_ONLY_ALIAS_GROUPS = [
  ['status', 'mailbox.status', 'heartbeat.status', 'project.task.status'],
] as const;

const SPEC_SAFE_ALIAS_LOOKUP = buildExplicitAliasLookup(SPEC_SAFE_ALIAS_GROUPS);
const RESOLUTION_ALIAS_LOOKUP = buildExplicitAliasLookup([
  ...SPEC_SAFE_ALIAS_GROUPS,
  ...RESOLUTION_ONLY_ALIAS_GROUPS,
]);

export function buildToolCompatibilityAliases(canonicalName: string): string[] {
  const canonical = canonicalName.trim();
  if (!canonical) return [];

  const aliases = new Set<string>();
  const parts = splitToolNameParts(canonical);
  if (parts.length === 0) return [];

  for (const variant of buildGeneratedVariants(parts)) {
    if (variant !== canonical) aliases.add(variant);
  }

  const explicitAliases = SPEC_SAFE_ALIAS_LOOKUP.get(normalizeToolAliasLookupKey(canonical)) ?? [];
  for (const alias of explicitAliases) {
    if (alias !== canonical) aliases.add(alias);
  }

  return Array.from(aliases);
}

export function buildToolResolutionCandidates(requestedToolName: string): string[] {
  const requested = requestedToolName.trim();
  if (!requested) return [];

  const candidates = new Set<string>([requested]);
  for (const alias of buildToolCompatibilityAliases(requested)) {
    candidates.add(alias);
  }

  const normalizedRequested = normalizeToolAliasLookupKey(requested);
  const explicitAliases = RESOLUTION_ALIAS_LOOKUP.get(normalizedRequested) ?? [];
  for (const alias of explicitAliases) {
    candidates.add(alias);
    for (const nestedAlias of buildToolCompatibilityAliases(alias)) {
      candidates.add(nestedAlias);
    }
  }

  return Array.from(candidates).filter((candidate) => candidate.trim().length > 0);
}

export function augmentToolSpecificationsWithCompatAliases<T extends ToolCompatSpecLike>(specs: T[]): T[] {
  if (!Array.isArray(specs) || specs.length === 0) return [];

  const seen = new Set<string>();
  const canonicalSpecs = new Map<string, T>();
  const augmented: T[] = [];

  for (const spec of specs) {
    if (!spec || typeof spec.name !== 'string') continue;
    const canonical = spec.name.trim();
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    canonicalSpecs.set(canonical, spec);
    augmented.push(spec);
  }

  for (const [canonical, canonicalSpec] of canonicalSpecs.entries()) {
    for (const alias of buildToolCompatibilityAliases(canonical)) {
      if (seen.has(alias)) continue;
      augmented.push({
        name: alias,
        description: canonicalSpec.description
          ? `Compatibility alias for ${canonical}: ${canonicalSpec.description}`
          : `Compatibility alias for ${canonical}`,
        inputSchema: canonicalSpec.inputSchema,
      } as T);
      seen.add(alias);
    }
  }

  return augmented;
}

export function normalizeToolAliasLookupKey(rawToolName: string): string {
  return rawToolName.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildExplicitAliasLookup(groups: ReadonlyArray<ReadonlyArray<string>>): Map<string, string[]> {
  const lookup = new Map<string, string[]>();
  for (const group of groups) {
    const uniqueGroup = Array.from(new Set(group.map((item) => item.trim()).filter(Boolean)));
    for (const alias of uniqueGroup) {
      const key = normalizeToolAliasLookupKey(alias);
      const siblings = uniqueGroup.filter((item) => item !== alias);
      lookup.set(key, siblings);
    }
  }
  return lookup;
}

function splitToolNameParts(toolName: string): string[] {
  return toolName
    .split(/[._-]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function buildGeneratedVariants(parts: string[]): string[] {
  const variants = new Set<string>();
  variants.add(parts.join('.'));
  variants.add(parts.join('_'));
  variants.add(parts.join('-'));
  variants.add(parts.join(''));
  variants.add(toCamelCase(parts));
  return Array.from(variants).filter((item) => isToolAliasCandidate(item));
}

function isToolAliasCandidate(value: string): boolean {
  return value.length > 0 && /^[a-zA-Z0-9_.-]+$/.test(value);
}

function toCamelCase(parts: string[]): string {
  if (parts.length === 0) return '';
  return parts
    .map((part, index) => {
      if (!part) return '';
      const lower = part.toLowerCase();
      if (index === 0) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}
