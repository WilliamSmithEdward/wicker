/*
 * Puts the repository's README, changelog and licence where vsce looks.
 *
 * vsce packages from this directory and ships only what .vscodeignore lets
 * through, which names these three files here. The originals live at the
 * repository root, where GitHub renders them, and the copies here are
 * ignored by git so there is one source for each. Nothing made the copies
 * until now: 0.7.0 and every release before it went to the marketplace with
 * no README, no changelog tab and no licence, and vsce only warns.
 *
 * Runs as vscode:prepublish, so a package or a publish cannot skip it, and it
 * fails rather than warns when a file is missing.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageDir, '..', '..');

for (const name of ['README.md', 'CHANGELOG.md', 'LICENSE']) {
  const source = join(repositoryRoot, name);
  if (!existsSync(source)) {
    console.error(`prepublish: ${name} is missing from ${repositoryRoot}`);
    process.exit(1);
  }
  copyFileSync(source, join(packageDir, name));
}
console.log('prepublish: README.md, CHANGELOG.md and LICENSE copied into the package');
