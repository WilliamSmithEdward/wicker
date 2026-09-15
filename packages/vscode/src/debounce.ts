import type * as vscode from 'vscode';

/**
 * Work deferred until a key goes quiet, and run early when something needs it.
 *
 * A keystroke fires a change event, and every tracker re-parsed the whole
 * document on each one: three full parses per character, on the extension
 * host, synchronously. The parsed result is only read when a query arrives
 * or when typing pauses. So the work is scheduled, and `flush` runs whatever
 * is pending the moment a reader asks. A burst of typing with no query in it
 * costs nothing until it ends.
 */
export class Deferred<T> implements vscode.Disposable {
  private readonly pending = new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void; value: T }>();

  constructor(private readonly delay: number) {}

  /** Replaces whatever was pending for the key; the latest value wins. */
  schedule(key: string, value: T, run: (value: T) => void): void {
    const waiting = this.pending.get(key);
    if (waiting !== undefined) { clearTimeout(waiting.timer); }
    const entry = { value, run: () => { this.pending.delete(key); run(value); }, timer: setTimeout(() => entry.run(), this.delay) };
    this.pending.set(key, entry);
  }

  /** Runs everything pending now, in the order it was scheduled. */
  flush(): void {
    for (const entry of [...this.pending.values()]) {
      clearTimeout(entry.timer);
      entry.run();
    }
  }

  /** Drops what was pending for the key without running it. */
  cancel(key: string): void {
    const waiting = this.pending.get(key);
    if (waiting !== undefined) {
      clearTimeout(waiting.timer);
      this.pending.delete(key);
    }
  }

  dispose(): void {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); }
    this.pending.clear();
  }
}
