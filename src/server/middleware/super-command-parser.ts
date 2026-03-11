/**
 * Super Command Parser
 * Parses <##@system##> and <##@agent##> tags for agent switching
 */

export interface SuperCommandBlock {
  type: 'system' | 'agent' | 'invalid';
  password?: string;
  content: string;
}

export interface ParsedMessage {
  type: 'super_command' | 'normal';
  blocks?: SuperCommandBlock[];
  effectiveContent: string;
  targetAgent: string;
  shouldSwitch: boolean;
}

const SYSTEM_TAG_PATTERN = /^<##@system(?::<pwd=([^>]+)>)?##>\s*/;
const AGENT_TAG_PATTERN = /^<##@agent##>\s*/;

/**
 * Parse message content for super command tags
 * - If <##@system##> or <##@agent##> tag exists at START, extract target agent
 * - Remove the tag from content for processing
 */
export function parseSuperCommand(content: string): ParsedMessage {
  const trimmed = content.trim();

  // Check for system tag at start
  const systemMatch = trimmed.match(SYSTEM_TAG_PATTERN);
  if (systemMatch) {
    const password = systemMatch[1];
    const remainingContent = trimmed.slice(systemMatch[0].length).trim();

    return {
      type: 'super_command',
      blocks: [{ type: 'system', password, content: remainingContent }],
      effectiveContent: remainingContent,
      targetAgent: 'finger-system-agent',
      shouldSwitch: true,
    };
  }

  // Check for agent tag at start
  const agentMatch = trimmed.match(AGENT_TAG_PATTERN);
  if (agentMatch) {
    const remainingContent = trimmed.slice(agentMatch[0].length).trim();

    return {
      type: 'super_command',
      blocks: [{ type: 'agent', content: remainingContent }],
      effectiveContent: remainingContent,
      targetAgent: 'finger-orchestrator',
      shouldSwitch: true,
    };
  }

  // No super command tag
  return {
    type: 'normal',
    effectiveContent: content,
    targetAgent: '',
    shouldSwitch: false,
  };
}
