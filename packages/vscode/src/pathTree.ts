/**
 * Grouping a flat list by the path each entry carries, a segment at a time.
 *
 * A list of endpoints is a wall of `/api/v1/...` prefixes that differ only at
 * the end, which is where the eye has to go on every row, and a list of
 * controllers repeats a namespace the same way. Grouped, the prefix is read
 * once. No editor types here, so the grouping is tested without one.
 */

/** The segments a path groups by: `/api/v1/items/{id}` is api, v1, items and {id}. */
export function pathSegments(path: string): readonly string[] {
  return path.split('/').filter((segment) => segment !== '');
}

export interface PathFolder {
  readonly name: string;
  /** The folder's own path, segments joined without a leading slash. */
  readonly path: string;
  /** How many entries sit beneath it, at any depth. */
  readonly count: number;
}

export interface PathLevel<T> {
  readonly folders: readonly PathFolder[];
  readonly leaves: readonly T[];
}

/** Whether a path lies strictly beneath a folder. */
function beneath(segments: readonly string[], folder: readonly string[]): boolean {
  return segments.length > folder.length && folder.every((segment, at) => segments[at] === segment);
}

/**
 * What sits directly under one folder; the empty path is the top.
 *
 * An entry is a leaf of the folder its path ends in, so `/api/items` sits
 * beside the `items` folder that holds `/api/items/{id}` rather than inside
 * it. A route's row already unfolds into what calls it, and giving it a second
 * kind of child would mix the two. Leaves keep the order they arrive in.
 */
export function pathLevel<T extends { readonly path: string }>(entries: readonly T[], folder: string): PathLevel<T> {
  const parent = pathSegments(folder);
  const folders = new Map<string, number>();
  const leaves: T[] = [];
  for (const entry of entries) {
    const segments = pathSegments(entry.path);
    // An entry at "/" has no segment to be named by, and belongs to the top.
    if (segments.length === 0) {
      if (parent.length === 0) { leaves.push(entry); }
      continue;
    }
    if (!beneath(segments, parent)) { continue; }
    if (segments.length === parent.length + 1) { leaves.push(entry); continue; }
    const name = segments[parent.length]!;
    folders.set(name, (folders.get(name) ?? 0) + 1);
  }
  return {
    folders: [...folders].map(([name, count]) => ({ name, path: [...parent, name].join('/'), count }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    leaves,
  };
}

/** The folder an entry is a leaf of, or a folder's own parent: everything but the last segment. */
export function parentPath(path: string): string {
  return pathSegments(path).slice(0, -1).join('/');
}

/** What an entry's row is called inside its folder: its last segment, or `/` for one at the top. */
export function leafName(path: string): string {
  return pathSegments(path).at(-1) ?? '/';
}

/**
 * The segments every path begins with, which is the part worth folding away.
 *
 * Controllers usually all sit in one namespace, and grouping by it would put
 * the whole list under a row that says `App` and another that says
 * `Controller`. What separates them is what comes after, so the shared head is
 * dropped. Never the whole of any path, or an entry would have no name left.
 */
export function commonPrefix(paths: readonly string[]): readonly string[] {
  const [first, ...rest] = paths.map((path) => pathSegments(path));
  if (first === undefined) { return []; }
  let shared = first.slice(0, -1);
  for (const segments of rest) {
    const limit = Math.min(shared.length, segments.length - 1);
    let at = 0;
    while (at < limit && shared[at] === segments[at]) { at++; }
    shared = shared.slice(0, at);
  }
  return shared;
}
