/**
 * Super Command Parser
 * Parses <##@...##> tags for agent/project/session switching
 * 
 * Syntax:
 * - <##@system##>message -> switch to system agent
 * - <##@system:pwd=xxx##>message -> switch to system agent with password
 * - <##@agent##>message -> switch back to business agent
 * - <##@project:list##> -> list available projects
 * - <##@project:switch@/path/to/project##> -> switch project
 * - <##@session:list##> -> list sessions in current project
 * - <##@session:switch@session-id##> -> switch to session
 */

export interface SuperCommandBlock {
  type: 'system' | 'agent' | 'project_list' | 'project_switch' | 'session_list' | 'session_switch' | 'invalid';
  password?: string;
  content: string;
  path?: string;  // for project:switch
  sessionId?: string;  // for session:switch
}

export interface ParsedMessage {
  type: 'super_command' | 'normal';
  blocks?: SuperCommandBlock[];
  effectiveContent: string;
  targetAgent: string;
  shouldSwitch: boolean;
}

// Match: <##@category##> or <##@category:action##> or <##@category:action@param##>
const TAG_PATTERN = /^<##@(\w+)(?::([^@#>]+))?(?:@([^>]+))?##>\s*/;

/**
 * Parse message content for super command tags
 */
export function parseSuperCommand(content: string): ParsedMessage {
  const trimmed = content.trim();
  const match = trimmed.match(TAG_PATTERN);

  if (!match) {
    return {
      type: 'normal',
      effectiveContent: content,
      targetAgent: '',
      shouldSwitch: false,
    };
  }

  const [fullMatch, category, actionRaw, param] = match;
  const remainingContent = trimmed.slice(fullMatch.length).trim();
  const action = actionRaw?.trim();

  // Parse based on category and action
  let block: SuperCommandBlock;

  if (category === 'system') {
    // <##@system##> or <##@system:pwd=xxx##>
    const password = action?.startsWith('pwd=') ? action.slice(4) : undefined;
    block = {
      type: 'system',
      password,
      content: remainingContent,
    };

    return {
      type: 'super_command',
      blocks: [block],
      effectiveContent: remainingContent,
      targetAgent: 'finger-system-agent',
      shouldSwitch: true,
    };
  }

  if (category === 'agent') {
    block = {
      type: 'agent',
      content: remainingContent,
    };

    return {
      type: 'super_command',
      blocks: [block],
      effectiveContent: remainingContent,
      targetAgent: 'finger-orchestrator',
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
