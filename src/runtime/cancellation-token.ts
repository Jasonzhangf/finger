export class CancellationToken {
  private _isCancelled = false;
  private _reason?: string;
  private _listeners: Array<(reason: string) => void> = [];
  private _childTokens: CancellationToken[] = [];

  get isCancelled(): boolean {
    return this._isCancelled;
  }

  get reason(): string | undefined {
    return this._reason;
  }

  cancel(reason?: string): void {
    if (this._isCancelled) return;
    this._isCancelled = true;
    this._reason = reason;
    for (const listener of this._listeners) {
      listener(reason ?? 'Cancelled');
    }
    for (const child of this._childTokens) {
      child.cancel(`Parent cancelled: ${reason ?? 'No reason'}`);
    }
  }

  onCancellation(listener: (reason: string) => void): () => void {
    if (this._isCancelled) {
      listener(this._reason ?? 'Cancelled');
      return () => {};
    }
    this._listeners.push(listener);
    return () => {
      this._listeners = this._listeners.filter(l => l !== listener);
    };
  }

  throwIfCancelled(): void {
    if (this._isCancelled) {
      throw new Error(`Operation cancelled: ${this._reason ?? 'No reason provided'}`);
    }
  }

  createChild(): CancellationToken {
    const child = new CancellationToken();
    this._childTokens.push(child);
    if (this._isCancelled) {
      child.cancel(`Parent already cancelled: ${this._reason ?? 'No reason'}`);
    }
    return child;
  }

  static createLinked(parent: CancellationToken): CancellationToken {
    return parent.createChild();
  }
}