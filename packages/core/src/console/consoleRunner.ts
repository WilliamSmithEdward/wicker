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

export interface ConsoleResult {
  readonly ok: boolean;
  readonly stdout: string;
  /** Why the run failed, for surfacing to the user rather than silent fallback. */
  readonly error: string | undefined;
}

export interface ConsoleRunner {
  /** Runs `bin/console` with the given arguments. Never throws. */
  run(args: readonly string[]): Promise<ConsoleResult>;
}

/** Where a set of loader paths came from, so the UI can explain itself. */
export type LoaderPathSource = 'console' | 'config';

export interface LoaderPathsResolution {
  readonly paths: TwigLoaderPaths;
  readonly source: LoaderPathSource;
  /** Present when the console was tried and could not be used. */
  readonly consoleError: string | undefined;
}

/**
 * Builds the loader paths, preferring the console and falling back to config.
 *
 * When the console answers, its entries come first and the configured ones are
 * appended: the console already reports everything twig.yaml declares, but
 * merging costs nothing and keeps a namespace resolvable if a future Symfony
 * version stops reporting one.
 *
 * A console failure is never fatal. The configured paths still resolve the
 * namespaces an application declares for itself, which is most of what its own
 * code references.
 */
export async function resolveLoaderPaths(
  runner: ConsoleRunner | undefined,
  configuredPaths: TwigLoaderPaths,
): Promise<LoaderPathsResolution> {
  if (runner === undefined) {
    return { paths: configuredPaths, source: 'config', consoleError: undefined };
  }

  const result = await runner.run(['debug:twig', '--format=json']);
  if (!result.ok) {
    return { paths: configuredPaths, source: 'config', consoleError: result.error ?? 'unknown' };
  }

  const payload = parseJsonLoosely(result.stdout);
  if (payload === undefined) {
    return {
      paths: configuredPaths,
      source: 'config',
      consoleError: 'debug:twig did not return readable JSON',
    };
  }

  const fromConsole = TwigLoaderPaths.fromDebugTwigJson(payload);
  const merged: LoaderPathEntry[] = [...fromConsole.all(), ...configuredPaths.all()];
  return {
    paths: TwigLoaderPaths.fromEntries(merged),
    source: 'console',
    consoleError: undefined,
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
