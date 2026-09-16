import { cssImports, importSpecifiers, type FrontendIndex } from '@wicker/core';

import { frontendIndex, isStylesheet, referencedAssetPath, resolveSpecifier } from './frontendProject.js';
import { templateScripts, walkTemplates } from './relatedScripts.js';
import type { ProjectSession, SessionManager } from './session.js';

export interface RelatedStyle {
  readonly projectPath: string;
  /** How the page reaches it, so a stylesheet from a layout explains itself. */
  readonly reasons: readonly string[];
}

/**
 * Stylesheets a page loads, by whatever route reaches them.
 *
 * CSS arrives several ways and a template usually names none of them:
 *
 *     base.html.twig  asset('styles/app.css')            a direct link
 *     base.html.twig  importmap('app')  -> app.js        -> './styles/app.css'
 *     page.html.twig  data-controller   -> foo_controller.js -> './foo.css'
 *                     any of those css  -> @import       -> more css
 *
 * So rather than enumerate routes, this seeds from everything a template
 * reaches and expands transitively: a script leads to its imports, a
 * stylesheet to the stylesheets it imports. Adding another way for a file to
 * be associated with a page makes its CSS reachable without changing anything
 * here.
 */
export async function templateStyles(sessions: SessionManager, session: ProjectSession,
  names: readonly string[]): Promise<readonly RelatedStyle[]> {
  const index = frontendIndex(sessions, session);
  const seeds = new Map<string, string>();

  walkTemplates(session, index, names, (file, name) => {
    for (const ref of file.scan.references) {
      const path = referencedAssetPath(session, ref);
      if (path !== undefined) {
        seeds.set(path, ref.kind === 'asset' ? `Linked by ${name}` : `Loaded by ${name} through the ${ref.name} entrypoint`);
      }
    }
  });

  // Everything already associated with the page: Stimulus controllers bound in
  // its markup, route consumers, and whatever else that list grows to cover.
  for (const script of await templateScripts(sessions, session, names)) {
    seeds.set(script.projectPath, script.reasons[0] ?? 'Associated script');
  }

  const found = new Map<string, Set<string>>();
  for (const [seed, reason] of seeds) {
    for (const stylesheet of stylesheetsFrom(session, index, seed)) {
      let reasons = found.get(stylesheet);
      if (!reasons) { reasons = new Set(); found.set(stylesheet, reasons); }
      reasons.add(reason);
    }
  }

  return [...found.entries()]
    .map(([projectPath, reasons]) => ({ projectPath, reasons: [...reasons].sort() }))
    .sort((left, right) => left.projectPath.localeCompare(right.projectPath));
}

/**
 * Stylesheets reachable from one file, following imports of both kinds.
 *
 * A seed may itself be a stylesheet, in which case it counts and its own
 * `@import`s are followed too.
 */
function stylesheetsFrom(session: ProjectSession, index: FrontendIndex, seed: string): string[] {
  const queue = [seed], visited = new Set<string>();
  const stylesheets: string[] = [];

  for (let at = 0; at < queue.length; at++) {
    const path = queue[at]!;
    if (visited.has(path)) { continue; }
    visited.add(path);

    if (isStylesheet(path)) { stylesheets.push(path); }

    const source = index.get(path)?.source;
    if (source === undefined) { continue; }

    const specifiers = isStylesheet(path)
      ? cssImports(source).map((entry) => entry.specifier)
      : importSpecifiers(source).map((entry) => entry.specifier);

    for (const specifier of specifiers) {
      const target = resolveSpecifier(session, path, specifier);
      if (target !== undefined && !visited.has(target)) { queue.push(target); }
    }
  }

  return stylesheets;
}

