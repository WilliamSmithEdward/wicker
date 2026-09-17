/**
 * The API routes as the paths they are, a level at a time.
 *
 * A flat list of endpoints reads as a wall of `/api/v1/...` prefixes that
 * differ only at the end, which is where the eye has to go on every row.
 * Grouped by path segment, the prefix is read once. No editor types here, so
 * the grouping is tested without one.
 */

/** The segments a path groups by: `/api/v1/items/{id}` is api, v1, items and {id}. */
export function routeSegments(path: string): readonly string[] {
  return path.split('/').filter((segment) => segment !== '');
}

export interface RouteFolder {
  readonly name: string;
  /** The folder's own path, segments joined without a leading slash. */
  readonly path: string;
  /** How many routes sit beneath it, at any depth. */
  readonly count: number;
}

export interface RouteLevel<T> {
  readonly folders: readonly RouteFolder[];
  readonly routes: readonly T[];
}

/** Whether a path lies strictly beneath a folder. */
function beneath(segments: readonly string[], folder: readonly string[]): boolean {
  return segments.length > folder.length && folder.every((segment, at) => segments[at] === segment);
}

/**
 * What sits directly under one folder; the empty path is the top.
 *
 * A route is a leaf of the folder its path ends in, so `/api/items` sits
 * beside the `items` folder that holds `/api/items/{id}` rather than inside
 * it. A route's row already unfolds into what calls it, and giving it a second
 * kind of child would mix the two. Routes keep the order they arrive in.
 */
export function routeLevel<T extends { readonly path: string }>(routes: readonly T[], folder: string): RouteLevel<T> {
  const parent = routeSegments(folder);
  const folders = new Map<string, number>();
  const leaves: T[] = [];
  for (const route of routes) {
    const segments = routeSegments(route.path);
    // The route at "/" has no segment to be named by, and belongs to the top.
    if (segments.length === 0) {
      if (parent.length === 0) { leaves.push(route); }
      continue;
    }
    if (!beneath(segments, parent)) { continue; }
    if (segments.length === parent.length + 1) { leaves.push(route); continue; }
    const name = segments[parent.length]!;
    folders.set(name, (folders.get(name) ?? 0) + 1);
  }
  return {
    folders: [...folders].map(([name, count]) => ({ name, path: [...parent, name].join('/'), count }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    routes: leaves,
  };
}

/** The folder a route is a leaf of, or a folder's own parent: everything but the last segment. */
export function routeFolderOf(path: string): string {
  return routeSegments(path).slice(0, -1).join('/');
}

/** What a route's row is called inside its folder: its last segment, or `/` for the route at the top. */
export function routeLeafName(path: string): string {
  return routeSegments(path).at(-1) ?? '/';
}
