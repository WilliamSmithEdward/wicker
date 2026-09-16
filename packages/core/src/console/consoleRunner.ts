/**
 * Asking Symfony to describe itself.
 *
 * `config/packages/twig.yaml` only knows the namespaces an application
 * declares for itself. Bundles register their own, so a project that reads
 * `@Twig/Exception/error404.html.twig` or overrides a bundle template has
 * namespaces that exist nowhere in its configuration files. Only
 * `bin/console debug:twig` knows the full set.
 *
 * Running a process is a capability the engine should not assume it has, so
 * the interface is defined here and the spawning is left to the host, which
 * knows whether PHP is reachable and whether the workspace is trusted.
 */

import { TwigLoaderPaths, type LoaderPathEntry } from '../twig/loaderPaths.js';
import { twigCallablesFromDebug, type TwigCallableCatalog } from '../twig/callables.js';

export interface ConsoleResult {
  readonly ok: boolean;
  readonly stdout: string;
  /** Why the run failed, for surfacing to the user rather than silent fallback. */
  readonly error: string | undefined;
  /**
   * True for an answer kept from an earlier run and given in place of one
   * the console has not given yet; `error` then says why. A reader says
   * where its data came from and holds back any check that needs a current
   * answer.
   */
  readonly remembered?: boolean;
}

/** The question that names the namespaces, asked the same way everywhere it is asked. */
export const DEBUG_TWIG_COMMAND: readonly string[] = ['debug:twig', '--format=json'];

export interface ConsoleRunner {
  /** Runs `bin/console` with the given arguments. Never throws. */
  run(args: readonly string[]): Promise<ConsoleResult>;
}

/**
 * Where a set of loader paths came from, so the UI can explain itself.
 *
 * `remembered` is a console answer from an earlier run, reused because the
 * console could not be reached this time.
 */
export type LoaderPathSource = 'console' | 'remembered' | 'config';

export interface LoaderPathsResolution {
  /** Fresh callable discovery from the same console invocation; never inferred from config. */
  readonly callables?: TwigCallableCatalog;
  readonly paths: TwigLoaderPaths;
  readonly source: LoaderPathSource;
  /** Present when the console was tried and could not be used. */
  readonly consoleError: string | undefined;
  /**
   * What the console said, for the host to remember for next time. Present
   * only when the console answered, so a host that stores this never
   * overwrites a good answer with a fallback.
   */
  readonly consoleEntries: readonly LoaderPathEntry[] | undefined;
}

/**
 * Builds the loader paths, preferring the console and falling back to config.
 *
 * When the console answers, its entries come first and the configured ones are
 * appended: the console already reports everything twig.yaml declares, but
 * merging costs nothing and keeps a namespace resolvable if a future Symfony
 * version stops reporting one.
 *
 * A console failure is never fatal. When an earlier answer was remembered it
 * is used, because namespaces change only when a bundle is installed or
 * removed: a stale list is almost always still right, while dropping to
 * configuration alone makes every bundle namespace look unregistered and
 * turns working code into reported errors. Failing that, the configured paths
 * still resolve the namespaces an application declares for itself.
 *
 * `remembered` is consulted only when the console was tried and failed. A
 * caller that passes no runner has switched the console off or is in an
 * untrusted workspace, and in both cases reusing an answer obtained under
 * different conditions would go behind the user's back.
 */
export async function resolveLoaderPaths(
  runner: ConsoleRunner | undefined,
  configuredPaths: TwigLoaderPaths,
  remembered?: readonly LoaderPathEntry[],
): Promise<LoaderPathsResolution> {
  if (runner === undefined) {
    return {
      paths: configuredPaths,
      source: 'config',
      consoleError: undefined,
      consoleEntries: undefined,
    };
  }

  const result = await runner.run(DEBUG_TWIG_COMMAND);
  if (!result.ok) {
    return withoutConsole(configuredPaths, remembered, result.error ?? 'unknown');
  }

  const payload = parseJsonLoosely(result.stdout);
  if (payload === undefined) {
    return withoutConsole(
      configuredPaths,
      remembered,
      'debug:twig did not return readable JSON',
    );
  }

  const fromConsole = TwigLoaderPaths.fromDebugTwigJson(payload);
  const merged: LoaderPathEntry[] = [...fromConsole.all(), ...configuredPaths.all()];
  if (result.remembered === true) {
    // An earlier run's answer, standing in until the console gives one: the
    // namespaces, which resolve files that are there to be checked, but not
    // the callables, since a check against a stale catalogue would report a
    // filter added since as unknown.
    return {
      paths: TwigLoaderPaths.fromEntries(merged),
      source: 'remembered',
      consoleError: result.error,
      consoleEntries: undefined,
    };
  }
  return {
    callables: twigCallablesFromDebug(payload),
    paths: TwigLoaderPaths.fromEntries(merged),
    source: 'console',
    consoleError: undefined,
    consoleEntries: fromConsole.all(),
  };
}

/** The best available answer when the console was asked and did not deliver. */
function withoutConsole(
  configuredPaths: TwigLoaderPaths,
  remembered: readonly LoaderPathEntry[] | undefined,
  consoleError: string,
): LoaderPathsResolution {
  if (remembered === undefined || remembered.length === 0) {
    return {
      paths: configuredPaths,
      source: 'config',
      consoleError,
      consoleEntries: undefined,
    };
  }

  return {
    paths: TwigLoaderPaths.fromEntries([...remembered, ...configuredPaths.all()]),
    source: 'remembered',
    consoleError,
    consoleEntries: undefined,
  };
}

/**
 * Parses JSON that may be preceded by other output.
 *
 * A Symfony console command can emit a deprecation notice or an Xdebug banner
 * before its payload, which would make a strict parse fail on an otherwise
 * perfectly good result. The first `{` is located and parsing starts there.
 */
export function parseJsonLoosely(raw: string): unknown {
  const direct = tryParse(raw);
  if (direct !== undefined) {
    return direct;
  }

  const firstBrace = raw.indexOf('{');
  if (firstBrace === -1) {
    return undefined;
  }
  return tryParse(raw.slice(firstBrace));
}

function tryParse(raw: string): unknown {
  try {
    const value: unknown = JSON.parse(raw);
    return value === null ? undefined : value;
  } catch {
    return undefined;
  }
}
