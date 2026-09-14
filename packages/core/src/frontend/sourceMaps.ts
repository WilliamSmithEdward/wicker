import { Buffer } from 'node:buffer';
import { normalizeProjectPath, projectPathDirname } from '../util/paths.js';
import { javascriptTokens } from './javascript.js';

/** Only local, one-source maps can replace generated JS in the tree. Bundles,
 * missing sources and external maps keep their JS identity. No code is run and
 * no remote URLs are read. This is file navigation, not offset mapping. */
export function typescriptSourceForJavascript(projectPath: string, source: string,
  read: (path: string) => string | undefined): string | undefined {
  if (!projectPath.endsWith('.js')) { return undefined; }
  const reference = sourceMappingUrl(source);
  if (!reference) { return undefined; }
  let raw: string | undefined, base = projectPath;
  if (reference.startsWith('data:')) {
    const match = /^data:application\/json(?:;charset=[\w-]+)?(;base64)?,(.*)$/.exec(reference);
    if (!match || reference.length > 1_000_000) { return undefined; }
    try { raw = match[1] ? Buffer.from(match[2]!, 'base64').toString('utf8') : decodeURIComponent(match[2]!); }
    catch { return undefined; }
  } else {
    const path = relativeSource(projectPath, reference);
    if (!path || !path.endsWith('.map')) { return undefined; }
    raw = read(path); base = path;
  }
  if (!raw || raw.length > 1_000_000) { return undefined; }
  let map: unknown;
  try { map = JSON.parse(raw); } catch { return undefined; }
  if (!map || typeof map !== 'object' || Array.isArray(map)) { return undefined; }
  const data = map as Record<string, unknown>;
  if (data['version'] !== 3 || data['sections'] !== undefined || !Array.isArray(data['sources']) ||
    data['sources'].length !== 1 || typeof data['sources'][0] !== 'string' ||
    typeof data['mappings'] !== 'string' || (data['sourceRoot'] !== undefined && typeof data['sourceRoot'] !== 'string')) { return undefined; }
  const sourceRoot = typeof data['sourceRoot'] === 'string' ? data['sourceRoot'] : '';
  if (!localRelative(sourceRoot) || !localRelative(data['sources'][0])) { return undefined; }
  const target = relativeSource(base, `${sourceRoot ? `${sourceRoot}/` : ''}${data['sources'][0]}`);
  return target?.endsWith('.ts') && !target.endsWith('.d.ts') && read(target) !== undefined ? target : undefined;
}

function localRelative(path: string): boolean { return !/^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(path) && !/[?#\0]/.test(path); }
function relativeSource(base: string, path: string): string | undefined {
  try { path = decodeURIComponent(path); } catch { return undefined; }
  return localRelative(path) ? normalizeProjectPath([projectPathDirname(base), path].filter(Boolean).join('/')) : undefined;
}

function sourceMappingUrl(source: string): string | undefined {
  let previous = 0, result: string | undefined;
  // The lexer consumes strings, templates and regex literals. Its gaps contain
  // only whitespace/comments, so a lookalike inside a JS string is not a map.
  for (const token of [...javascriptTokens(source), { start: source.length, end: source.length }]) {
    const gap = source.slice(previous, token.start);
    for (const match of gap.matchAll(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g)) {
      const body = match[0].startsWith('//') ? match[0].slice(2) : match[0].slice(2, -2);
      const mapping = /^[#@]\s+sourceMappingURL=(\S+)\s*$/.exec(body);
      if (mapping) { result = mapping[1]; }
    }
    previous = token.end;
  }
  return result;
}
