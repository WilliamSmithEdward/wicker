/**
 * The two questions asked of loosely parsed JSON before it is picked apart.
 *
 * Console output, importmap entries and composer manifests are all read with
 * `parseJsonLoosely` and then walked, and every walker started by asking
 * whether it was holding a plain object rather than an array, a string or
 * null. Three files each answered that with their own copy; these are the
 * one answer, in the two shapes the callers use.
 */

/** True for a plain object: not null, not an array. Narrows the type. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value as a plain object, or nothing, for callers that chain on it. */
export function objectOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
