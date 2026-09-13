/*
 * Builds the .vsix.
 *
 * README.md, CHANGELOG.md and LICENSE live at the repository root and are the
 * only copies. The marketplace reads them from the extension directory, so
 * they are copied in at package time and deleted afterwards rather than
 * checked in twice. Two copies in the tree drift, and the one that drifts is
 * always the one the public reads.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageDirectory, '..', '..');

/** Root file to its name inside the package. Both are the same here. */
const DOCUMENTS = ['README.md', 'CHANGELOG.md', 'LICENSE'];

const { version } = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
const output = join('dist', `wicker-${version}.vsix`);

for (const document of DOCUMENTS) {
  copyFileSync(join(repositoryRoot, document), join(packageDirectory, document));
}

/*
 * vsce is run through Node against its resolved entry point rather than
 * through npx. npx would fetch it at package time, which makes the contents of
 * a release depend on what the registry served that day, and on Windows Node
 * refuses to spawn the .cmd shim without a shell.
 */
const vsce = join(
  dirname(createRequire(import.meta.url).resolve('@vscode/vsce/package.json')),
  'vsce',
);

try {
  mkdirSync(join(packageDirectory, 'dist'), { recursive: true });
  execFileSync(process.execPath, [vsce, 'package', '--no-dependencies', '--out', output], {
    cwd: packageDirectory,
    stdio: 'inherit',
  });
} finally {
  // Always, so a failed package run does not leave copies behind to be
  // committed by accident.
  for (const document of DOCUMENTS) {
    rmSync(join(packageDirectory, document), { force: true });
  }
}

console.log(`\npackaged ${output}`);
