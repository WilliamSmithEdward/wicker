/**
 * Parsing and formatting of Twig template references as Symfony writes them.
 *
 * Three forms occur in a Symfony 8 codebase:
 *
 *   home/index.html.twig    the main namespace, resolved against `templates/`
 *   \@Maker/foo.html.twig    a registered namespace, here the MakerBundle
 *   \@!Maker/foo.html.twig   the same namespace, forced to the bundle's own copy
 *                           rather than an application override
 *
 * The legacy `Bundle:Controller:view` syntax was removed in Symfony 5 and is
 * deliberately not supported; it is reported as a problem so the caller can
 * offer a migration message instead of silently failing to resolve.
 */

/** The main namespace has no name. Symfony's debug:twig prints it as `(None)`. */
export const MAIN_NAMESPACE = null;

/** The label `bin/console debug:twig --format=json` uses for the main namespace. */
export const MAIN_NAMESPACE_LABEL = '(None)';

export interface TwigTemplateName {
  /** The reference exactly as it appeared in source. */
  readonly raw: string;
  /** Namespace without its `@` or `!` sigils, or null for the main namespace. */
  readonly namespace: string | null;
  /** Path below the namespace root, always forward-slashed, never leading-slashed. */
  readonly path: string;
  /**
   * True for the `@!Bundle/...` form, which pins resolution to the bundle's own
   * template and skips any application-level override.
   */
  readonly forcesBundleTemplate: boolean;
}

export type TemplateNameProblemKind =
  | 'empty'
  | 'namespace-without-path'
  | 'empty-namespace'
  | 'parent-traversal'
  | 'legacy-bundle-syntax';

export interface TemplateNameProblem {
  readonly kind: TemplateNameProblemKind;
  readonly message: string;
}

export type ParsedTemplateName =
  | { readonly ok: true; readonly value: TwigTemplateName }
  | { readonly ok: false; readonly problem: TemplateNameProblem };

function problem(kind: TemplateNameProblemKind, message: string): ParsedTemplateName {
  return { ok: false, problem: { kind, message } };
}

/**
 * Whether a name climbs above the directory it is resolved against.
 *
 * Twig counts segments rather than banning `..`, so `home/../index.html.twig`
 * is a real name that resolves, and only a name that would leave the loader
 * directory is refused. Rejecting every `..` reported the legal form as broken.
 */
function escapesLoaderPath(path: string): boolean {
  let depth = 0;
  for (const part of path.split('/')) {
    if (part === '..') { depth -= 1; }
    else if (part !== '.') { depth += 1; }
    if (depth < 0) { return true; }
  }
  return false;
}

/** Resolves "." and ".." the way the filesystem does when Twig joins the path. */
function collapseSegments(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '.') { continue; }
    if (part === '..') { parts.pop(); continue; }
    parts.push(part);
  }
  return parts.join('/');
}

/** Matches the removed Symfony 2/3 reference form, e.g. `AcmeBundle:Default:index.html.twig`. */
const LEGACY_BUNDLE_SYNTAX = /^[A-Za-z0-9_]+Bundle:[A-Za-z0-9_]*:/;

/**
 * Parses a Twig template reference.
 *
 * The input is taken verbatim from source, so it is not trimmed: leading or
 * trailing whitespace inside the string literal is a real authoring mistake and
 * would change which file Twig looks for.
 */
export function parseTemplateName(raw: string): ParsedTemplateName {
  if (raw.length === 0) {
    return problem('empty', 'Template name is empty.');
  }

  if (LEGACY_BUNDLE_SYNTAX.test(raw)) {
    return problem(
      'legacy-bundle-syntax',
      'The Bundle:Controller:view template syntax was removed in Symfony 5. ' +
        'Use the @Namespace/path.html.twig form instead.',
    );
  }

  /*
   * Twig normalises a name before it resolves anything: FilesystemLoader's
   * normalizeName turns backslashes into forward slashes and collapses runs of
   * slashes. Treating either as an authoring mistake reported a broken
   * reference for a name Twig loads perfectly well.
   */
  const normalized = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/');

  let namespace: string | null = MAIN_NAMESPACE;
  let forcesBundleTemplate = false;
  let path = normalized;

  if (normalized.startsWith('@')) {
    let cursor = 1;
    if (normalized.startsWith('@!')) {
      forcesBundleTemplate = true;
      cursor = 2;
    }

    const separator = normalized.indexOf('/', cursor);
    if (separator === -1) {
      return problem(
        'namespace-without-path',
        `"${raw}" names a namespace but no template within it.`,
      );
    }

    namespace = normalized.slice(cursor, separator);
    if (namespace.length === 0) {
      return problem('empty-namespace', 'Template namespace is empty.');
    }

    path = normalized.slice(separator + 1);
  }

  // Stripped rather than refused, because Twig's own validateName ltrims it and
  // the lookup that follows joins the loader directory to whatever is left, so
  // the doubled separator collapses and the file is found.
  path = path.replace(/^\/+/, '');

  if (path.length === 0) {
    return problem(
      'namespace-without-path',
      `"${raw}" names a namespace but no template within it.`,
    );
  }

  if (escapesLoaderPath(path)) {
    return problem('parent-traversal',
      'Twig template names cannot traverse above a loader path.');
  }

  // The file the lookup actually reaches. Twig joins the loader directory to
  // the name and leaves the rest to the filesystem, which resolves "." and
  // ".." on the way, so home/../home/index.html.twig and home/index.html.twig
  // are one template. Collapsing here means the index, the diagnostics and the
  // offer to create a missing file all name the same place.
  path = collapseSegments(path);
  if (path.length === 0) {
    return problem('namespace-without-path', `"${raw}" names no template.`);
  }

  return {
    ok: true,
    value: { raw, namespace, path, forcesBundleTemplate },
  };
}

/** Renders a parsed name back to the form Twig and Symfony expect. */
export function formatTemplateName(name: {
  namespace: string | null;
  path: string;
  forcesBundleTemplate?: boolean;
}): string {
  if (name.namespace === MAIN_NAMESPACE) {
    return name.path;
  }
  const sigil = name.forcesBundleTemplate === true ? '@!' : '@';
  return `${sigil}${name.namespace}/${name.path}`;
}

/**
 * Normalizes the namespace key reported by `debug:twig --format=json`.
 *
 * That command labels the main namespace `(None)` and lists the bundle-override
 * form as a separate `@!Name` key, so both are folded back into the internal
 * representation here.
 */
export function normalizeLoaderNamespaceKey(key: string): {
  namespace: string | null;
  forcesBundleTemplate: boolean;
} {
  if (key === MAIN_NAMESPACE_LABEL) {
    return { namespace: MAIN_NAMESPACE, forcesBundleTemplate: false };
  }
  if (key.startsWith('@!')) {
    return { namespace: key.slice(2), forcesBundleTemplate: true };
  }
  if (key.startsWith('@')) {
    return { namespace: key.slice(1), forcesBundleTemplate: false };
  }
  return { namespace: key, forcesBundleTemplate: false };
}
