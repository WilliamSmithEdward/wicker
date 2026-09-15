import { LoaderPathMemory } from '../loaderPathMemory.js';
import { SessionManager } from '../session.js';

/**
 * A session manager whose remembered namespaces live in this process only.
 *
 * The real one remembers console answers in workspace state, which would
 * carry one test's answers into the next. Backing it with a map gives each
 * caller its own memory, and the map is owned here because no test reads it
 * back: what they check is what the sessions do with it.
 */
export function memorySessions(): SessionManager {
  const memory = new Map<string, unknown>();
  return new SessionManager(new LoaderPathMemory({
    keys: () => [...memory.keys()],
    get: <T>(key: string, fallback?: T): T | undefined => (memory.get(key) as T | undefined) ?? fallback,
    update: (key, value) => { memory.set(key, value); return Promise.resolve(); },
  }));
}
