/**
 * How long the console took, kept so a slow open can be read off.
 *
 * On a container or a remote machine the console is most of what a person
 * waits for, and "it hangs for a while" cannot be acted on: whether one
 * command is slow or all of them, a cold boot or every boot, decides what
 * would help. No editor types here, so the wording is tested without one.
 */

/** One command's last run. */
export interface ConsoleTiming {
  readonly command: readonly string[];
  readonly ms: number;
  readonly ok: boolean;
}

/** A command as a person would name it: `debug:router`, `debug:config stimulus`. */
export function commandLabel(command: readonly string[]): string {
  const words: string[] = [];
  for (const word of command) {
    if (word.startsWith('-')) { break; }
    words.push(word);
  }
  return words.join(' ');
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** The report's line: every command asked, slowest first, saying which did not answer. */
export function describeTimings(timings: readonly ConsoleTiming[]): string {
  if (timings.length === 0) { return 'not asked'; }
  return [...timings].sort((left, right) => right.ms - left.ms)
    .map((timing) => `${commandLabel(timing.command)} ${timing.ok ? '' : 'failed after '}${seconds(timing.ms)}`)
    .join(', ');
}

/** The slowest command that answered, which is the one number a tooltip has room for. */
export function slowestAnswer(timings: readonly ConsoleTiming[]): ConsoleTiming | undefined {
  return timings.filter((timing) => timing.ok).sort((left, right) => right.ms - left.ms)[0];
}
