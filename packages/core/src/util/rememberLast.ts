/**
 * Remembers the last answer of a parse, for a file read several times over.
 *
 * Indexing one file runs several readers across it back to back, each handed
 * the same source: a PHP controller's routes, the templates those routes
 * render and its constructor dependencies are three separate passes, and a
 * Twig template's regions are lexed again by each of the three things that
 * want them. Without this, a file is parsed once per reader rather than once.
 *
 * One entry is enough because those readers are consecutive rather than
 * interleaved. Holding more would mean holding whole projects.
 */

/**
 * Source above this is not retained: its parse costs the most to keep and is
 * the least likely to be asked for several times in a row.
 */
const MAX_REMEMBERED = 512 * 1024;

export function rememberLast<T>(parse: (source: string) => T): (source: string) => T {
  let remembered: { readonly source: string; readonly result: T } | undefined;
  return (source: string): T => {
    if (remembered !== undefined && remembered.source === source) {
      return remembered.result;
    }
    const result = parse(source);
    remembered = source.length <= MAX_REMEMBERED ? { source, result } : undefined;
    return result;
  };
}
