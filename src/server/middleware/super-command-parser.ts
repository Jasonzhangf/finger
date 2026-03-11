/**
 * Super Command Parser
 * Parses <####>...<####> blocks with <##@system##> and <##@agent##> tags
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

const BLOCK_PATTERN = /<####>([\s\S]*?)<####>/g;
const SYSTEM_TAG_PATTERN = /<##@system(?::<pwd=([^>]+)>)?##>/;
const AGENT_TAG_PATTERN = /<##@agent##>/;

/**
 * Parse message content for super command blocks
 * - If super command blocks exist, ignore content outside blocks
 * - Extract target agent and password from tags
 */
export function parseSuperCommand(content: string): ParsedMessage {
  const blocks: SuperCommandBlock[] = [];
  let hasSuperBlock = false;

  // Reset regex state
  BLOCK_PATTERN.lastIndex = 0;

  // Extract all super command blocks
  let match;
  while ((match = BLOCK_PATTERN.exec(content)) !== null) {
    hasSuperBlock = true;
    const blockContent = match[1].trim();

    const systemMatch = blockContent.match(SYSTEM_TAG_PATTERN);
    const agentMatch = blockContent.match(AGENT_TAG_PATTERN);

    if (systemMatch) {
      const password = systemMatch[1];
      const actualContent = blockContent
        .replace(SYSTEM_TAG_PATTERN, '')
        .trim();

      blocks.push({
        type: 'system',
        password,
        content: actualContent
      });
    } else if (agentMatch) {
      const actualContent = blockContent
        .replace(AGENT_TAG_PATTERN, '')
        .trim();

      blocks.push({
        type: 'agent',
        content: actualContent
      });
    } else {
      blocks.push({
        type: 'invalid',
        content: blockContent
      });
    }
  }

  // No super command block, use original content
  if (!hasSuperBlock) {
    return {
      type: 'normal',
      effectiveContent: content,
      targetAgent: '',
      shouldSwitch: false
    };
  }

  // Has super command block, only use block content, ignore content outside blocks
  const firstBlock = blocks[0];
  const targetAgent = firstBlock.type === 'system'
    ? 'finger-system-agent'
    : firstBlock.type === 'agent'
      ? 'finger-orchestrator'
      : '';

  // Merge all block contents
  const effectiveContent = blocks
    .filter(b => b.content)
    .map(b => b.content)
    .join('\n');

  return {
    type: 'super_command',
    blocks,
    effectiveContent,
    targetAgent,
    shouldSwitch: firstBlock.type === 'system' || firstBlock.type === 'agent'
  };
}
