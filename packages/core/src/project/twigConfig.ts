/**
 * Reading Twig's namespace configuration straight from `config/packages/twig.yaml`.
 *
 * `bin/console debug:twig` is the more complete answer because it also knows
 * the namespaces bundles register. It also needs a working PHP, which is not
 * always available: the editor may be running on a host where the project is
 * only visible over a share, with PHP living inside a container.
 *
 * So this is the floor, not a fallback of last resort. It covers the namespaces
 * an application declares for itself, which is what application code actually
 * references, and it works everywhere with no process to spawn.
 */

import { parseYaml } from '../util/yaml.js';

import {
  DEFAULT_TEMPLATE_DIRECTORY,
  TwigLoaderPaths,
  type LoaderPathEntry,
} from '../twig/loaderPaths.js';
import { MAIN_NAMESPACE } from '../twig/templateName.js';
import { normalizeProjectPath } from '../util/paths.js';

/** Where the Twig bundle configuration conventionally lives. */
export const TWIG_CONFIG_PATH = 'config/packages/twig.yaml';

/** Container parameters that can appear in a configured path. */
interface ParameterBindings {
  readonly projectDir: string;
}

export interface TwigConfig {
  /** Namespace entries declared by the application, main namespace included. */
  readonly entries: readonly LoaderPathEntry[];
  /** The `file_name_pattern` setting, when one is declared. */
  readonly fileNamePatterns: readonly string[];
}

const EMPTY_CONFIG: TwigConfig = { entries: [], fileNamePatterns: [] };

/**
 * Parses twig.yaml into loader path entries.
 *
 * Returns empty rather than throwing for malformed YAML: the file is edited by
 * hand and is routinely invalid mid-keystroke, which must not break the index.
 */
export function parseTwigConfig(raw: string): TwigConfig {
  const document: unknown = parseYaml(raw);
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return EMPTY_CONFIG;
  }

  const root = document as Record<string, unknown>;

  // Environment overlays are merged on top of the base section, in file order,
  // so `when@dev` additions are visible. Production-only overlays are skipped
  // because the editor models a development checkout.
  const sections: unknown[] = [root['twig']];
  for (const [key, value] of Object.entries(root)) {
    if (key === 'when@dev' && typeof value === 'object' && value !== null) {
      sections.push((value as Record<string, unknown>)['twig']);
    }
  }

  const entries: LoaderPathEntry[] = [];
  const fileNamePatterns: string[] = [];

  for (const section of sections) {
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
      continue;
    }
    const twig = section as Record<string, unknown>;

    for (const pattern of readStringList(twig['file_name_pattern'])) {
      fileNamePatterns.push(pattern);
    }

    entries.push(...readPaths(twig['paths']));
  }

  return { entries, fileNamePatterns };
}

/**
 * Builds loader paths for a project from its twig.yaml, always including the
 * conventional `templates/` root that Symfony registers implicitly.
 */
export function loaderPathsFromTwigConfig(config: TwigConfig): TwigLoaderPaths {
  const entries: LoaderPathEntry[] = [
    {
      namespace: MAIN_NAMESPACE,
      forcesBundleTemplate: false,
      directories: [DEFAULT_TEMPLATE_DIRECTORY],
    },
    ...config.entries,
  ];
  return TwigLoaderPaths.fromEntries(entries);
}

/**
 * Reads the `paths` mapping.
 *
 * Symfony writes it as path to namespace, which is the reverse of how it reads,
 * and a null or empty namespace means the main namespace.
 */
function readPaths(value: unknown): LoaderPathEntry[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }

  const entries: LoaderPathEntry[] = [];

  // The mapping form: { '%kernel.project_dir%/design': Design }
  if (!Array.isArray(value)) {
    for (const [rawPath, rawNamespace] of Object.entries(value as Record<string, unknown>)) {
      const directory = resolveConfiguredPath(rawPath);
      if (directory === undefined) {
        continue;
      }
      const namespace =
        typeof rawNamespace === 'string' && rawNamespace.length > 0 ? rawNamespace : MAIN_NAMESPACE;
      entries.push({ namespace, forcesBundleTemplate: false, directories: [directory] });
    }
    return entries;
  }

  // The sequence form: a bare list of directories, all main namespace.
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const directory = resolveConfiguredPath(item);
    if (directory !== undefined) {
      entries.push({
        namespace: MAIN_NAMESPACE,
        forcesBundleTemplate: false,
        directories: [directory],
      });
    }
  }
  return entries;
}

/**
 * Turns a configured path into a project-relative directory.
 *
 * Only `%kernel.project_dir%` is substituted. A path rooted anywhere else
 * cannot be expressed relative to the project, so it is dropped rather than
 * guessed at; the console remains the way to learn about those.
 */
function resolveConfiguredPath(
  rawPath: string,
  bindings: ParameterBindings = { projectDir: '' },
): string | undefined {
  let value = rawPath.trim();
  if (value.length === 0) {
    return undefined;
  }

  const projectDirPattern = /^%kernel\.project_dir%\/?/;
  if (projectDirPattern.test(value)) {
    value = value.replace(projectDirPattern, bindings.projectDir);
  } else if (value.includes('%')) {
    // Some other container parameter; not resolvable without the container.
    return undefined;
  }

  return normalizeProjectPath(value);
}

function readStringList(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

/**
 * Turns Twig's `file_name_pattern` globs into the suffix list the index uses.
 *
 * Only the common `*.ext` shape is understood; anything more elaborate falls
 * back to the caller's default rather than being approximated.
 */
export function extensionsFromPatterns(
  patterns: readonly string[],
  fallback: readonly string[],
): readonly string[] {
  const extensions: string[] = [];
  for (const pattern of patterns) {
    const match = /^\*(\.[A-Za-z0-9._-]+)$/.exec(pattern.trim());
    if (match?.[1] !== undefined) {
      extensions.push(match[1]);
    }
  }
  return extensions.length > 0 ? extensions : fallback;
}
