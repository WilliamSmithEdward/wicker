import type * as vscode from 'vscode';

/**
 * Remembers what `bin/console` last said about a project, command by command.
 *
 * Every answer costs a kernel boot, and on a container or a remote machine the
 * six a project asks on opening are most of what a person waits for. The last
 * answers are kept in workspace state so the next opening is drawn from them
 * at once and the console asked after: what it says replaces what was
 * remembered, and a check that needs a current answer holds back until then.
 *
 * Stored as the console's own output, so the parsers that treat that output
 * as untrusted read it back the same way and nothing is trusted twice. The
 * record holds nothing about the machine it came from, so it stays valid
 * across a container rebuild and travels with the workspace.
 */

/**
 * Bumped when the stored shape changes, so an old record is ignored rather
 * than misread. Answers are recorded again by the next successful console run.
 */
const KEY_PREFIX = 'wicker.console.v1:';

/** An answer this large is not worth carrying between sessions; the console is asked instead. */
const MAX_ANSWER_LENGTH = 1_000_000;

export class ConsoleMemory {
  constructor(private readonly store: vscode.Memento) {}

  /** The last output of a command for a project, if one was stored and still reads. */
  recall(projectRoot: string, command: readonly string[]): string | undefined {
    return this.record(projectRoot)[JSON.stringify(command)];
  }

  /**
   * Records a command's output. Callers pass only what the console produced.
   *
   * Written only when the answer changed: a PHP save asks three questions,
   * and rewriting the record for each was a write per keystroke-and-save.
   */
  async remember(projectRoot: string, command: readonly string[], stdout: string): Promise<void> {
    if (stdout.length > MAX_ANSWER_LENGTH) {
      return;
    }
    const key = JSON.stringify(command);
    const record = this.record(projectRoot);
    if (record[key] === stdout) {
      return;
    }
    await this.store.update(KEY_PREFIX + projectRoot, { ...record, [key]: stdout });
  }

  /**
   * What is stored for a project, keeping only what still reads as output.
   *
   * The store survives extension upgrades and can be edited by hand, so what
   * comes back is untrusted input rather than something the type says it is.
   */
  private record(projectRoot: string): Readonly<Record<string, string>> {
    const stored = this.store.get<unknown>(KEY_PREFIX + projectRoot);
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
      return {};
    }
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  }
}
