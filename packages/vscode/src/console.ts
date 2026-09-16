import { execFile } from 'node:child_process';

import * as vscode from 'vscode';

import type { ConsoleResult, ConsoleRunner } from '@wicker/core';

/**
 * How long a console command may take before it is abandoned.
 *
 * Opening a project boots the kernel six times at once, and on a container
 * or a remote machine with a cold cache that took longer than the fifteen
 * seconds this used to be. Every answer was killed and reported as a
 * failure, and a retry a moment later, against the cache those runs had
 * warmed, succeeded: a console that seemed unreachable until refreshed. The
 * tree no longer waits for the answers, so waiting longer for them costs
 * nothing but a row saying so.
 */
const TIMEOUT_MS = 60_000;

/** Output cap, so a runaway command cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** The command used when none is configured. */
const DEFAULT_COMMAND: readonly string[] = ['php', 'bin/console'];

/**
 * Runs `bin/console` as a child process.
 *
 * The command is configurable because PHP is not always where the editor is.
 * A common arrangement, and the one Wicker is developed against, has the
 * editor on a host with no PHP at all and the application inside a container,
 * which is reached with `docker exec <container> php bin/console`.
 */
export class ProcessConsoleRunner implements ConsoleRunner {
  private readonly command: readonly string[];
  private readonly cwd: string;
  /**
   * Commands already running, so the same one is never spawned twice at once.
   *
   * Opening a project asks the console seven questions together, and two of
   * them are the same question: both the asset map and Stimulus discovery need
   * the project directory. Each answer costs a Symfony kernel boot, which on a
   * container or a remote machine is the slowest thing the extension does.
   *
   * In flight only. A finished answer is not kept, because the console is the
   * authority on a project that is still being edited.
   */
  private readonly running = new Map<string, Promise<ConsoleResult>>();

  private constructor(command: readonly string[], cwd: string, private readonly timeoutMs: number) {
    this.command = command;
    this.cwd = cwd;
  }

  /**
   * Builds a runner, or returns undefined when one must not be used.
   *
   * Declines when the feature is switched off, and when the workspace is not
   * trusted: the command can come from workspace settings, so running it in an
   * untrusted folder would execute whatever that folder asked for. That is
   * exactly the case workspace trust exists to prevent.
   *
   * The wait is settable so a test can see a command run out of time without
   * waiting a minute for it.
   */
  static create(projectRoot: string, timeoutMs = TIMEOUT_MS): ProcessConsoleRunner | undefined {
    const settings = vscode.workspace.getConfiguration('wicker');
    if (!settings.get<boolean>('console.enabled', true)) {
      return undefined;
    }
    if (!vscode.workspace.isTrusted) {
      return undefined;
    }

    const configured = settings.get<string[]>('console.command', []);
    const command = configured.length > 0 ? configured : DEFAULT_COMMAND;
    return new ProcessConsoleRunner(command, projectRoot, timeoutMs);
  }

  /** A readable form of the command, for status messages. */
  describe(): string {
    return this.command.join(' ');
  }

  run(args: readonly string[]): Promise<ConsoleResult> {
    const key = JSON.stringify(args);
    const found = this.running.get(key);
    if (found !== undefined) { return found; }
    const started = this.spawn(args).finally(() => this.running.delete(key));
    this.running.set(key, started);
    return started;
  }

  private spawn(args: readonly string[]): Promise<ConsoleResult> {
    const [executable, ...leading] = this.command;
    if (executable === undefined) {
      return Promise.resolve({ ok: false, stdout: '', error: 'no console command configured' });
    }

    return new Promise<ConsoleResult>((resolve) => {
      execFile(
        executable,
        [...leading, ...args],
        {
          cwd: this.cwd,
          timeout: this.timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          // Not run through a shell: arguments are passed as a list, so a path
          // containing a space or a quote cannot change what is executed.
          shell: false,
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ ok: true, stdout, error: undefined });
            return;
          }
          // A non-zero exit still carries useful output sometimes, but the
          // caller cannot tell a partial result from a complete one, so a
          // failure is reported as a failure and the reason is preserved. A
          // command killed for running out of time has no output and no
          // exit code to explain itself with, so it is named as such rather
          // than as "Command failed", which reads as a broken console.
          resolve({
            ok: false,
            stdout,
            error: error.killed
              ? `no answer within ${this.timeoutMs / 1000} seconds`
              : firstLine(stderr) ?? error.message,
          });
        },
      );
    });
  }
}

function firstLine(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.split(/\r?\n/)[0];
}
