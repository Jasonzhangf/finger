/**
 * Command Parser - Parse <##...##> syntax
 */

import { Command, CommandType } from './types.js';

const COMMAND_PATTERN = /<##(?:@(\w+)(?::([^@#>]+))?(?:@([^>]+))?|(\w+))##>/g;

export interface ParseResult {
  commands: Command[];
  effectiveContent: string;
}

/**
 * Parse <##...##> tags from input string
 */
export function parseCommands(input: string): ParseResult {
  const commands: Command[] = [];
  const matches = [...input.matchAll(COMMAND_PATTERN)];

  if (matches.length === 0) {
    return {
      commands: [],
      effectiveContent: input
    };
  }

  let effectiveContent = input;

  for (const match of matches) {
    const [fullMatch, category, actionRaw, param, simpleCommand] = match;
    const matchIndex = match.index!;
    
    const command = parseSingleCommand(fullMatch, category, actionRaw, param, simpleCommand, effectiveContent);
    if (command) {
      commands.push(command);
      effectiveContent = `${effectiveContent.slice(0, matchIndex)}${effectiveContent.slice(matchIndex + fullMatch.length)}`.trim();
    }
  }

  return { commands, effectiveContent: effectiveContent.trim() };
}

function parseSingleCommand(
  fullMatch: string,
  category: string | undefined,
  actionRaw: string | undefined,
  param: string | undefined,
  simpleCommand: string | undefined,
  input: string
): Command | null {
  const action = actionRaw?.trim();
  const params: Record<string, string> = {};

  if (simpleCommand) {
    if (simpleCommand === 'help') {
      return {
        type: CommandType.CMD_LIST,
        raw: fullMatch,
        content: '',
        params: {}
      };
    }
    return null;
  }

  if (!category) {
    return null;
  }

  // Build params object
  if (param) {
    params.param = param;
  }
  if (action) {
    params.action = action;
  }

  // Determine command type
  let type: CommandType;

  if (category === 'cmd') {
    type = CommandType.CMD_LIST;
  } else if (category === 'system') {
    if (action === 'restart') {
      type = CommandType.SYSTEM_RESTART;
    } else if (action === 'provider:list') {
      type = CommandType.PROVIDER_LIST;
    } else if (action?.startsWith('provider:switch@')) {
      type = CommandType.PROVIDER_SWITCH;
      params.providerId = action.replace('provider:switch@', '');
    } else if (action?.startsWith('clock:')) {
      const clockAction = action.slice(6); // remove 'clock:'
      if (clockAction === 'list') {
        type = CommandType.CLOCK_LIST;
      } else if (clockAction === 'cancel' || clockAction.startsWith('cancel@')) {
        type = CommandType.CLOCK_CANCEL;
        if (clockAction.startsWith('cancel@')) {
          params.timerId = action.slice(18); // remove 'clock:cancel@'
        } else if (param) {
          params.timerId = param;
        }
      } else if (clockAction.startsWith('create')) {
        type = CommandType.CLOCK_CREATE;
        // Parse clock parameters from param if present
        if (param) {
          try {
            const clockParams = JSON.parse(param);
            Object.assign(params, clockParams);
          } catch {
            // If not JSON, treat as message
            params.message = param;
          }
        }
      } else {
        type = CommandType.INVALID;
      }
    } else {
      type = CommandType.SYSTEM;
      if (action?.startsWith('pwd=')) {
        params.password = action.slice(4);
      }
    }
  } else if (category === 'agent') {
    if (action === 'list' || !action) {
      type = CommandType.AGENT_LIST;
      if (param && param.startsWith('/')) {
        params.path = param;
      }
    } else if (action === 'new') {
      type = CommandType.AGENT_NEW;
    } else if (action === 'switch' && param) {
      type = CommandType.AGENT_SWITCH;
      params.sessionId = param;
    } else if (action === 'delete' && param) {
      type = CommandType.AGENT_DELETE;
      params.sessionId = param;
    } else {
      type = CommandType.AGENT;
    }
  } else if (category === 'project') {
    if (action === 'list' || !action) {
      type = CommandType.PROJECT_LIST;
    } else if (action === 'switch' && param) {
      type = CommandType.PROJECT_SWITCH;
      params.path = param;
    } else {
      type = CommandType.INVALID;
    }
  } else if (category === 'session') {
    if (action === 'list' || !action) {
      type = CommandType.SESSION_LIST;
    } else if (action === 'switch' && param) {
      type = CommandType.SESSION_SWITCH;
      params.sessionId = param;
    } else {
      type = CommandType.INVALID;
    }
  } else {
    type = CommandType.INVALID;
  }

  const remainingContent = extractRemainingContent(input, fullMatch);

  return {
    type,
    raw: fullMatch,
    content: remainingContent,
    params
  };
}

function extractRemainingContent(input: string, match: string): string {
  const index = input.indexOf(match);
  if (index === -1) return input;
  return `${input.slice(0, index)}${input.slice(index + match.length)}`.trim();
}
