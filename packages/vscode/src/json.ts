/**
 * The value as a plain object, or nothing.
 *
 * Console output is parsed loosely and then picked apart, and every reader
 * had to ask the same question first: is this a JSON object, rather than an
 * array, a string or null? Two discoveries each answered it with their own
 * copy of this function.
 */
export function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
