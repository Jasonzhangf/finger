import { statSync } from 'fs';
import path from 'path';
import { InternalTool, ToolExecutionContext } from './types.js';

interface ViewImageInput {
  path: string;
}

export interface ViewImageOutput {
  ok: boolean;
  content: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

export const viewImageTool: InternalTool<unknown, ViewImageOutput> = {
  name: 'view_image',
  description: 'Attach a local image (by filesystem path) to the conversation context for this turn.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Local filesystem path to an image file' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  execute: async (rawInput: unknown, context: ToolExecutionContext): Promise<ViewImageOutput> => {
    const input = parseViewImageInput(rawInput);
    const resolvedPath = path.isAbsolute(input.path)
      ? input.path
      : path.resolve(context.cwd, input.path);

    const stat = statSync(resolvedPath, { throwIfNoEntry: false });
    if (!stat) {
      throw new Error(`image file does not exist: ${resolvedPath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`path is not a file: ${resolvedPath}`);
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const mimeType = MIME_BY_EXTENSION[ext];
    if (!mimeType) {
      throw new Error(`unsupported image extension: ${ext || '(none)'}`);
    }

    return {
      ok: true,
      content: 'attached local image path',
      path: resolvedPath,
      mimeType,
      sizeBytes: stat.size,
    };
  },
};

function parseViewImageInput(rawInput: unknown): ViewImageInput {
  if (!isRecord(rawInput)) {
    throw new Error('view_image input must be an object');
  }
  if (typeof rawInput.path !== 'string' || rawInput.path.trim().length === 0) {
    throw new Error('view_image input.path must be a non-empty string');
  }
  return {
    path: rawInput.path.trim(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
