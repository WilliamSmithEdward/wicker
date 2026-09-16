import { cssImports, cssUrls, importSpecifiers } from '@wicker/core';

import { frontendIndex, isStylesheet, resolveSpecifier } from './frontendProject.js';
import { walkTemplates } from './relatedScripts.js';
import type { ProjectSession, SessionManager } from './session.js';
import { basename } from './paths.js';

export interface ChainEntry {
  readonly projectPath: string;
  /** Why this file is loaded, for the row that shows it. */
  readonly reason: string;
}

/**
 * The files a page loads, one step at a time.
 *
 * A template renders `importmap('app')` and everything else follows from
 * there: the entrypoint imports a bootstrap, the bootstrap imports a
 * stylesheet, the stylesheet imports more. None of those names appear in any
 * template, so the only way to answer "why is this file on the page" has been
 * to open each file in turn and read its imports.
 *
 * Returned a level at a time rather than flattened, so the answer can be
 * explored instead of listed: each step says what it is and what brought it
 * in, and a file that imports nothing simply has no children.
 */
export function templateEntrypoints(sessions: SessionManager, session: ProjectSession,
  names: readonly string[]): readonly ChainEntry[] {
  const index = frontendIndex(sessions, session);
  const found = new Map<string, string>();

  walkTemplates(session, index, names, (file, name) => {
    for (const ref of file.scan.references) {
      if (ref.kind === 'entrypoint') {
        const entry = session.assets.importMap.find((candidate) => candidate.specifier === ref.name);
        if (entry?.projectPath !== undefined) {
          found.set(entry.projectPath, `importmap('${ref.name}') in ${name}`);
        }
      }
      if (ref.kind === 'asset') {
        const asset = session.assets.map.lookup(ref.name);
        if (asset) { found.set(asset.projectPath, `asset('${ref.name}') in ${name}`); }
      }
    }
  });

  return [...found.entries()].map(([projectPath, reason]) => ({ projectPath, reason }))
    .sort((left, right) => left.projectPath.localeCompare(right.projectPath));
}

/**
 * What one file in the chain pulls in directly.
 *
 * A script's imports, or a stylesheet's `@import`s and `url()` references. A
 * specifier that resolves to nothing is left out rather than shown as a
 * broken row: the import diagnostics already report it where it is written.
 */
export function chainChildren(sessions: SessionManager, session: ProjectSession,
  projectPath: string): readonly ChainEntry[] {
  const index = frontendIndex(sessions, session);
  const source = index.get(projectPath)?.source;
  if (source === undefined) { return []; }

  const stylesheet = isStylesheet(projectPath);
  const specifiers = stylesheet
    ? [...cssImports(source), ...cssUrls(source)].map((entry) => ({ text: entry.specifier, how: 'imported by' }))
    : importSpecifiers(source).map((entry) => ({ text: entry.specifier, how: entry.dynamic ? 'imported on demand by' : 'imported by' }));

  const file = basename(projectPath);
  const found = new Map<string, string>();
  for (const specifier of specifiers) {
    const target = resolveSpecifier(session, projectPath, specifier.text);
    // A specifier resolving to nothing is reported where it is written, by the
    // import diagnostics. A row here would say it twice and explain it less.
    if (target === undefined || target === projectPath) { continue; }
    found.set(target, `${specifier.how} ${file}`);
  }

  return [...found.entries()].map(([target, reason]) => ({ projectPath: target, reason }))
    .sort((left, right) => left.projectPath.localeCompare(right.projectPath));
}
