import { frontendIndex } from './frontendProject.js';
import { walkTemplates } from './relatedScripts.js';
import type { ProjectSession, SessionManager } from './session.js';

export interface RelatedStyle {
  readonly projectPath: string;
  /** Which template links it, so a stylesheet from a layout is explainable. */
  readonly reasons: readonly string[];
}

/**
 * Stylesheets a page links, following its layout and includes.
 *
 * A template names a stylesheet through `asset('styles/app.css')`, and the
 * link is nearly always in a base layout rather than the page itself. So
 * "which CSS does this page load" is a question nobody can answer by reading
 * the file in front of them, which is exactly the gap worth closing.
 *
 * Only literal `asset()` arguments that resolve to a mapped `.css` file are
 * listed. A computed path names nothing checkable, and a path outside the
 * asset map is not served, so neither is claimed.
 */
export function templateStyles(sessions: SessionManager, session: ProjectSession,
  names: readonly string[]): readonly RelatedStyle[] {
  const index = frontendIndex(sessions, session);
  const found = new Map<string, Set<string>>();

  walkTemplates(session, index, names, (file, name) => {
    for (const ref of file.scan.references) {
      if (ref.kind !== 'asset' || !ref.name.toLowerCase().endsWith('.css')) { continue; }
      const asset = session.assets.map.lookup(ref.name);
      if (!asset) { continue; }
      let reasons = found.get(asset.projectPath);
      if (!reasons) { reasons = new Set(); found.set(asset.projectPath, reasons); }
      reasons.add(`Linked by ${name}`);
    }
  });

  return [...found.entries()]
    .map(([projectPath, reasons]) => ({ projectPath, reasons: [...reasons].sort() }))
    .sort((left, right) => left.projectPath.localeCompare(right.projectPath));
}
