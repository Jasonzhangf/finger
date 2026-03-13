/**
 * Super Command Parser
 * Parses <##@...##> tags for agent/project/session switching
 * 
 * Syntax:
 * - <##@system##>message -> switch to system agent
 * - <##@system:pwd=xxx##>message -> switch to system agent with password
 * - <##@system:restart##> -> trigger daemon restart (MessageHub handled)
 * - <##@agent##>message -> switch back to business agent
 * - <##@agent:list##> -> list sessions in current project
 * - <##@agent:list@/path##> -> list sessions in specified project
 * - <##@agent:new##> -> create new session in current project
 * - <##@agent:new@/path##> -> create new session in specified project
 * - <##@agent:switch@id##> -> switch to session
 * - <##@agent:delete@id##> -> delete session
 * - <##@project:list##> -> list all projects
 * - <##@project:switch@/path##> -> switch project
 * - <##cmd:list##> or <##help##> -> list all commands
 *
 * Note: /resume is now handled by agents (not MessageHub)
 * - Agents can use their session switching tool to change sessions
 * - System Agent can switch any agent's session
 * - Normal agents can only switch their own session
 */

export interface SuperCommandBlock {
  type:
    | 'system'
    | 'agent'
    | 'agent_list'
    | 'agent_new'
    | 'agent_switch'
    | 'agent_delete'
    | 'project_list'
    | 'project_switch'
    | 'session_list'
    | 'session_switch'
    | 'cmd_list'
    | 'invalid';
  password?: string;
  content: string;
  path?: string;  // for project:switch, agent:list@path, agent:new@path
  sessionId?: string;  // for agent:switch, agent:delete
}

export interface ParsedMessage {
  type: 'super_command' | 'normal';
  blocks?: SuperCommandBlock[];
  effectiveContent: string;
  targetAgent: string;
  shouldSwitch: boolean;
}

// Match:
// - <##@category##> or <##@category:action##> or <##@category:action@param##>
// - <##help##> (alias for cmd:list)
// NOTE: /resume is NOT handled here anymore - agents handle it via their session tools
const TAG_PATTERN = /<##(?:@(\w+)(?::([^@#>]+))?(?:@([^>]+))?|help)##>/;

/**
 * Parse message content for super command tags
 */
export function parseSuperCommand(content: string): ParsedMessage {
  const match = content.match(TAG_PATTERN);

  if (!match) {
    return {
      type: 'normal',
      effectiveContent: content,
      targetAgent: '',
      shouldSwitch: false,
    };
  }

  const [fullMatch, category, actionRaw, param] = match;
  const matchIndex = match.index ?? 0;
  const remainingContent = `${content.slice(0, matchIndex)}${content.slice(matchIndex + fullMatch.length)}`.trim();

  if (fullMatch === '<##help##>') {
    const block: SuperCommandBlock = { type: 'cmd_list', content: '' };
    return {
      type: 'super_command',
      blocks: [block],
      effectiveContent: remainingContent,
      targetAgent: '',
      shouldSwitch: false,
    };
  }
  const action = actionRaw?.trim();

  // Parse based on category and action
  let block: SuperCommandBlock;

  if (category === 'cmd') {
    if (action === 'list' || !action) {
      block = {
        type: 'cmd_list',
        content: '',
      };
    } else {
      block = { type: 'invalid', content: remainingContent };
    }

    return {
      type: 'super_command',
      blocks: [block],
      effectiveContent: '',
      targetAgent: '',
      shouldSwitch: false,
    };
  }

  if (category === 'agent') {
    if (action === 'list' || !action) {
      block = {
        type: 'agent_list',
        content: '',
        path: param && param.startsWith('/') ? param : undefined,
      };
    } else if (action === 'new') {
      block = {
        type: 'agent_new',
        content: '',
        path: param || undefined,
      };
    } else if (action === 'switch' && param) {
      block = {
        type: 'agent_switch',
        content: '',
        sessionId: param,
      };
    } else if (action === 'delete' && param) {
      block = {
        type: 'agent_delete',
        content: '',
        sessionId: param,
      };
    } else {
      block = { type: 'invalid', content: remainingContent };
    }

    return {
      type: 'super_command',
      blocks: [block],
      effectiveContent: remainingContent,
      targetAgent: 'finger-orchestrator',
      shouldSwitch: true,
    };
  }

  if (category === 'system') {
    // <##@system##> or <##@system:pwd=xxx##> or <##@system:restart##>
    if (action === 'restart') {
      block = {
        type: 'system' as const,
        password: undefined,
        content: 'restart',
      };
    } else {
      const password = action?.startsWith('pwd=') ? action.slice(4) : undefined;
      block = {
        type: 'system',
        password,
        content: remainingContent,
      };
    }

    return {
      type: 'super_command',
      blocks: [block],
      effectiveContent: remainingContent,
      targetAgent: 'finger-system-agent',
      shouldSwitch: true,
    };
  }

  if (category === 'project') {
    if (action === 'list' || !action) {
      block = {
        type: 'project_list',
        content: '',
      };
    } else if (action === 'switch' && param) {
      block = {
        type: 'project_switch',
        content: '',
        path: param,
      };
    } else {
      block = { type: 'invalid', content: remainingContent };
    }

    return {
      type: 'super_command',
      blocks: [block],
      effectiveContent: '',
      targetAgent: '',
      shouldSwitch: false,
    };
  }

  if (category === 'session') {
    if (action === 'list' || !action) {
      block = {
        type: 'session_list',
        content: '',
      };
    } else if (action === 'switch' && param) {
      block = {
        type: 'session_switch',
        content: '',
        sessionId: param,
      };
    } else {
      block = { type: 'invalid', content: remainingContent };
    }

    return {
      type: 'super_command',
      blocks: [block],
      effectiveContent: '',
      targetAgent: '',
      shouldSwitch: false,
    };
  }

  // Unknown category
  return {
    type: 'normal',
    effectiveContent: content,
    targetAgent: '',
    shouldSwitch: false,
  };
}
