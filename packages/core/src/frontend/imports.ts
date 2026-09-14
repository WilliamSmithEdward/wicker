/**
 * The specifiers a JavaScript file imports.
 *
 * Under AssetMapper there is no bundler resolving these: the browser does it,
 * against the importmap the page ships. So a specifier is either relative, and
 * resolved against the importing file, or it is a key of `importmap.php` and
 * resolved by lookup. Anything else fails in the browser, and with
 * `missing_import_mode: strict` it fails the request outright.
 *
 * Only literal specifiers are reported. `import(base + name)` is computed at
 * runtime and naming a file for it would be a guess.
 */

import { javascriptTokens, stringRange, type JsToken } from './javascript.js';
import type { OffsetRange } from '../php/templateReferences.js';
import { normalizeProjectPath, projectPathDirname } from '../util/paths.js';

export interface ImportSpecifier {
  readonly specifier: string;
  /** Offsets of the text inside the quotes. */
  readonly range: OffsetRange;
  /** True for `import(...)`, which the browser resolves the same way. */
  readonly dynamic: boolean;
}

export function importSpecifiers(source: string): readonly ImportSpecifier[] {
  const tokens = javascriptTokens(source);
  const found: ImportSpecifier[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.text !== 'import' && token.text !== 'export') { continue; }

    const next = tokens[i + 1];
    if (next === undefined) { continue; }

    // `import.meta.url` is a property access, not a module specifier.
    if (next.text === '.') { continue; }

    if (token.text === 'import' && next.text === '(') {
      const argument = tokens[i + 2];
      if (isString(argument) && tokens[i + 3]?.text === ')') {
        found.push(entry(argument, true));
      }
      continue;
    }

    if (token.text === 'import' && isString(next)) {
      // `import './side-effect.js'`
      found.push(entry(next, false));
      continue;
    }

    // Otherwise the specifier follows `from`, within this statement.
    for (let j = i + 1; j < tokens.length; j++) {
      const candidate = tokens[j]!;
      if (candidate.text === 'import' || candidate.text === 'export' || candidate.text === ';') { break; }
      if (candidate.text !== 'from') { continue; }
      const specifier = tokens[j + 1];
      if (isString(specifier)) {
        found.push(entry(specifier, false));
      }
      i = j + 1;
      break;
    }
  }

  return found;
}

/**
 * Where a relative specifier points, as a project-relative path.
 *
 * Undefined for a bare specifier, which names an importmap key rather than a
 * location, and for one that climbs out of the project.
 */
export function resolveRelativeImport(fromProjectPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return undefined;
  }
  const directory = projectPathDirname(fromProjectPath);
  return normalizeProjectPath(directory === undefined ? specifier : `${directory}/${specifier}`);
}

function entry(token: JsToken, dynamic: boolean): ImportSpecifier {
  return { specifier: token.value ?? '', range: stringRange(token), dynamic };
}

function isString(token: JsToken | undefined): token is JsToken {
  return token?.kind === 'string' && token.value !== undefined;
}
