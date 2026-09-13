/**
 * Deciding whether a directory is a Symfony project, and finding the one that
 * governs a given file.
 *
 * The answer carries its reasons. Wicker activates real behaviour on the back
 * of this decision, so when it declines to activate, or activates somewhere
 * surprising, the user should be able to see exactly what was detected rather
 * than being told "no Symfony project found" with nothing to act on.
 */

import { directoryExists, fileExists, type WickerFileSystem } from '../fs/fileSystem.js';
import { ancestorDirectories, joinProjectPath, normalizeRootPath } from '../util/paths.js';

import { parseComposerManifest, type ComposerManifest } from './composer.js';

/** An observed fact about a directory, whether or not it is decisive. */
export type SymfonyEvidence =
  | 'framework-bundle'
  | 'bundles-config'
  | 'kernel-class'
  | 'twig-bundle'
  | 'console-script'
  | 'symfony-package'
  | 'templates-directory';

/**
 * Evidence that identifies a Symfony application.
 *
 * Each of these is something every Symfony application has and nothing else
 * does. The weaker signals are recorded for display but never decide: a
 * `bin/console` script describes any Console-based CLI tool, a `symfony/`
 * requirement describes any library using a component, and a `templates/`
 * directory describes almost anything.
 */
const CONCLUSIVE_EVIDENCE: readonly SymfonyEvidence[] = [
  'framework-bundle',
  'bundles-config',
  'kernel-class',
];

export interface SymfonyProject {
  /** Absolute, normalized project root: the directory holding composer.json. */
  readonly root: string;
  readonly manifest: ComposerManifest;
  /** Everything observed, in a stable order, whether or not it was decisive. */
  readonly evidence: readonly SymfonyEvidence[];
  /** True when Twig is installed, so template features are worth offering. */
  readonly hasTwig: boolean;
}

/**
 * Examines one directory. Returns undefined when it holds no composer.json, or
 * holds one that does not describe a Symfony application.
 */
export async function inspectDirectory(
  fileSystem: WickerFileSystem,
  directory: string,
): Promise<SymfonyProject | undefined> {
  const root = normalizeRootPath(directory);

  const composerRaw = await fileSystem.readFile(joinProjectPath(root, 'composer.json'));
  if (composerRaw === undefined) {
    return undefined;
  }
  const manifest = parseComposerManifest(composerRaw);
  if (manifest === undefined) {
    return undefined;
  }

  const evidence: SymfonyEvidence[] = [];
  if (manifest.requirements.has('symfony/framework-bundle')) {
    evidence.push('framework-bundle');
  }
  if (manifest.requirements.has('symfony/twig-bundle')) {
    evidence.push('twig-bundle');
  }
  if ([...manifest.requirements.keys()].some((name) => name.startsWith('symfony/'))) {
    evidence.push('symfony-package');
  }
  if (await fileExists(fileSystem, joinProjectPath(root, 'config/bundles.php'))) {
    evidence.push('bundles-config');
  }
  if (await fileExists(fileSystem, joinProjectPath(root, 'src/Kernel.php'))) {
    evidence.push('kernel-class');
  }
  if (await fileExists(fileSystem, joinProjectPath(root, 'bin/console'))) {
    evidence.push('console-script');
  }
  if (await directoryExists(fileSystem, joinProjectPath(root, 'templates'))) {
    evidence.push('templates-directory');
  }

  if (!isSymfonyProject(evidence)) {
    return undefined;
  }

  return {
    root,
    manifest,
    evidence,
    // Twig may be present as a transitive dependency of twig-bundle only, so a
    // templates directory alongside any Symfony install also counts.
    hasTwig:
      evidence.includes('twig-bundle') ||
      manifest.requirements.has('twig/twig') ||
      evidence.includes('templates-directory'),
  };
}

/** Whether the gathered evidence identifies a Symfony application. */
export function isSymfonyProject(evidence: readonly SymfonyEvidence[]): boolean {
  return evidence.some((item) => CONCLUSIVE_EVIDENCE.includes(item));
}

/**
 * Walks upward from a file or directory to find the project that governs it.
 *
 * The nearest project wins, which is what makes a monorepo behave: a file in
 * `apps/api/src` belongs to `apps/api`, not to the repository root that also
 * happens to carry a composer.json.
 */
export async function discoverSymfonyProject(
  fileSystem: WickerFileSystem,
  startDirectory: string,
): Promise<SymfonyProject | undefined> {
  const start = normalizeRootPath(startDirectory);
  for (const directory of [start, ...ancestorDirectories(start)]) {
    const project = await inspectDirectory(fileSystem, directory);
    if (project !== undefined) {
      return project;
    }
  }
  return undefined;
}

/**
 * Finds every Symfony project at or below a directory, without descending into
 * a project once found.
 *
 * `maxDepth` bounds the walk because a workspace root can contain a very large
 * tree, and directories that never hold a project are skipped by name so a
 * scan does not spend its budget inside vendor/ or node_modules/.
 */
export async function findSymfonyProjects(
  fileSystem: WickerFileSystem,
  searchRoot: string,
  maxDepth = 3,
): Promise<readonly SymfonyProject[]> {
  const found: SymfonyProject[] = [];
  await walk(normalizeRootPath(searchRoot), 0);
  return found;

  async function walk(directory: string, depth: number): Promise<void> {
    const project = await inspectDirectory(fileSystem, directory);
    if (project !== undefined) {
      found.push(project);
      // A Symfony project does not nest another one; vendor/ holds libraries.
      return;
    }
    if (depth >= maxDepth) {
      return;
    }
    for (const entry of await fileSystem.readDirectory(directory)) {
      if (entry.type !== 'directory' || isSkippedDirectory(entry.name)) {
        continue;
      }
      await walk(joinProjectPath(directory, entry.name), depth + 1);
    }
  }
}

const SKIPPED_DIRECTORIES = new Set([
  'vendor',
  'node_modules',
  'var',
  'public',
  'dist',
  'out',
  'build',
  'coverage',
]);

function isSkippedDirectory(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIRECTORIES.has(name);
}
