/**
 * AgentPath - Agent hierarchy path system for multi-agent collaboration.
 *
 * Represents hierarchical agent paths like `/root/explorer/worker`.
 * Supports relative reference resolution similar to file paths.
 */
export class AgentPath {
  static readonly ROOT = '/root';

  /** Segment validation regex: lowercase letter followed by lowercase letters, digits, or underscores */
  private static readonly SEGMENT_REGEX = /^[a-z][a-z0-9_]*$/;

  /** Reserved segment names that are not allowed */
  private static readonly RESERVED_SEGMENTS = new Set(['root', '.', '..', '']);

  /** Maximum segment length */
  private static readonly MAX_SEGMENT_LENGTH = 64;

  /** Minimum segment length */
  private static readonly MIN_SEGMENT_LENGTH = 1;

  /** The internal path string, always normalized to absolute form starting with /root */
  private constructor(private readonly path: string) {}

  // ============ Factory Methods ============

  /**
   * Returns the root path `/root`.
   */
  static root(): AgentPath {
    return new AgentPath(AgentPath.ROOT);
  }

  /**
   * Creates an AgentPath from a string representation.
   * @throws ValidationError if the path is invalid
   */
  static fromString(path: string): AgentPath {
    const result = AgentPath.tryFromString(path);
    if (result === null) {
      throw new ValidationError(`Invalid agent path: "${path}"`);
    }
    return result;
  }

  /**
   * Creates an AgentPath from a string representation without throwing.
   * Returns null if the path is invalid.
   */
  static tryFromString(path: string): AgentPath | null {
    if (!AgentPath.isValid(path)) {
      return null;
    }
    return new AgentPath(path);
  }

  /**
   * Creates an AgentPath from individual segments.
   * Segments are joined under `/root`.
   * @throws ValidationError if any segment is invalid
   */
  static fromSegments(...segments: string[]): AgentPath {
    for (const segment of segments) {
      if (!AgentPath.isValidSegment(segment)) {
        throw new ValidationError(`Invalid segment: "${segment}"`);
      }
    }

    if (segments.length === 0) {
      return AgentPath.root();
    }

    return new AgentPath(`${AgentPath.ROOT}/${segments.join('/')}`);
  }

  // ============ Validation ============

  /**
   * Checks if a path string is a valid AgentPath.
   */
  static isValid(path: string): boolean {
    if (typeof path !== 'string') {
      return false;
    }

    // Must start with /root
    if (path === AgentPath.ROOT) {
      return true;
    }

    if (!path.startsWith(AgentPath.ROOT + '/')) {
      return false;
    }

    // Extract segments after /root/
    const segmentsStr = path.slice(AgentPath.ROOT.length + 1);
    if (segmentsStr.length === 0) {
      return false; // Trailing slash like "/root/"
    }

    const segments = segmentsStr.split('/');
    for (const segment of segments) {
      if (!AgentPath.isValidSegment(segment)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Checks if a segment string is valid for use in an AgentPath.
   */
  static isValidSegment(segment: string): boolean {
    if (typeof segment !== 'string') {
      return false;
    }

    if (AgentPath.RESERVED_SEGMENTS.has(segment)) {
      return false;
    }

    if (segment.length < AgentPath.MIN_SEGMENT_LENGTH || segment.length > AgentPath.MAX_SEGMENT_LENGTH) {
      return false;
    }

    return AgentPath.SEGMENT_REGEX.test(segment);
  }

  // ============ Path Operations ============

  /**
   * Returns the last segment of the path.
   * For root, returns "root".
   */
  name(): string {
    const parts = this.path.split('/');
    return parts[parts.length - 1] || 'root';
  }

  /**
   * Returns the parent path, or null if this is root.
   */
  parent(): AgentPath | null {
    if (this.isRoot()) {
      return null;
    }

    const lastSlash = this.path.lastIndexOf('/');
    if (lastSlash <= 0) {
      return null;
    }

    return new AgentPath(this.path.slice(0, lastSlash));
  }

  /**
   * Joins a segment to this path.
   * @throws ValidationError if the segment is invalid
   */
  join(segment: string): AgentPath {
    if (!AgentPath.isValidSegment(segment)) {
      throw new ValidationError(`Invalid segment: "${segment}"`);
    }
    return new AgentPath(`${this.path}/${segment}`);
  }

  /**
   * Resolves a relative reference against this path.
   *
   * Supports:
   * - `./child` - child of current
   * - `../sibling` - sibling under parent
   * - `sibling` - sibling of current (same as `../sibling`)
   * - `../..` - go up two levels
   * - `/root/absolute` - absolute path (ignores current path)
   *
   * @throws ValidationError if the reference cannot be resolved or result is invalid
   */
  resolve(reference: string): AgentPath {
    // Absolute path - validate and return directly
    if (reference.startsWith('/')) {
      return AgentPath.fromString(reference);
    }

    const parts = reference.split('/');
    let current: AgentPath | null = this;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      if (part === '.') {
        // Current directory - no change
        continue;
      } else if (part === '..') {
        // Parent directory
        current = current?.parent() ?? null;
        if (current === null) {
          throw new ValidationError(`Cannot resolve reference "${reference}": would go above root`);
        }
      } else if (part === '') {
        // Empty part (consecutive slashes) - skip
        continue;
      } else {
        // Regular segment - validate and join
        if (!AgentPath.isValidSegment(part)) {
          throw new ValidationError(`Invalid segment in reference: "${part}"`);
        }
        current = new AgentPath(`${current!.path}/${part}`);
      }
    }

    if (current === null) {
      throw new ValidationError(`Cannot resolve reference "${reference}": result is null`);
    }

    return current;
  }

  // ============ Query Methods ============

  /**
   * Checks if this path is the root path.
   */
  isRoot(): boolean {
    return this.path === AgentPath.ROOT;
  }

  /**
   * Returns the depth of this path.
   * Root has depth 0, /root/a has depth 1, /root/a/b has depth 2, etc.
   */
  depth(): number {
    if (this.isRoot()) {
      return 0;
    }
    // Count segments after /root
    return this.path.split('/').length - 2;
  }

  // ============ Serialization ============

  /**
   * Returns the string representation of this path.
   */
  toString(): string {
    return this.path;
  }

  /**
   * Compares this path with another for equality.
   */
  equals(other: AgentPath): boolean {
    return this.path === other.path;
  }

  /**
   * Returns the segments of this path (excluding the root prefix).
   */
  segments(): string[] {
    if (this.isRoot()) {
      return [];
    }
    return this.path.slice(AgentPath.ROOT.length + 1).split('/');
  }
}

/**
 * Error thrown when validation fails for AgentPath operations.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
