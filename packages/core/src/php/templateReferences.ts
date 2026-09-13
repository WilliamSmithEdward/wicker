/**
 * Finding the places PHP names a Twig template.
 *
 * This is the controller half of the bridge. A Symfony controller refers to
 * its template as a bare string, so without this the editor sees an ordinary
 * string literal and the connection is invisible.
 *
 * It walks the token stream from the lexer rather than building a syntax
 * tree. What is needed here is shallow, a call and its arguments, and a token
 * walk is enough to get it exactly right while staying small. Broader PHP
 * features will want a real tree; the lexer is shared either way.
 *
 * Positions are returned as character offsets rather than line and column
 * pairs. The editor layer converts them using the document's own line index,
 * which keeps UTF-16 arithmetic where the document lives.
 */

import { significantTokens, type PhpToken } from './lexer.js';

/** A half-open character range within the scanned source. */
export interface OffsetRange {
  readonly start: number;
  readonly end: number;
}

export type TemplateReferenceKind =
  | 'render'
  | 'renderView'
  | 'renderBlock'
  | 'renderBlockView'
  | 'renderForm'
  | 'stream'
  | 'template-attribute';

/** Method names that take a template name as their first argument. */
const RENDER_METHODS: ReadonlyMap<string, TemplateReferenceKind> = new Map([
  ['render', 'render'],
  ['renderview', 'renderView'],
  ['renderblock', 'renderBlock'],
  ['renderblockview', 'renderBlockView'],
  ['renderform', 'renderForm'],
  ['stream', 'stream'],
]);

/** Matched on the trailing segment, so a fully qualified attribute also counts. */
const TEMPLATE_ATTRIBUTES: ReadonlySet<string> = new Set(['template']);

const TEMPLATE_ARGUMENT_NAMES: ReadonlySet<string> = new Set(['view', 'template', 'name']);

const CONTEXT_ARGUMENT_NAMES: ReadonlySet<string> = new Set([
  'parameters',
  'context',
  'variables',
  'data',
]);

const TYPE_KEYWORDS: ReadonlySet<string> = new Set(['class', 'interface', 'trait', 'enum']);

export interface TemplateReference {
  readonly templateName: string;
  /** Offsets of the name itself, inside the quotes. */
  readonly nameRange: OffsetRange;
  /** Offsets of the whole call or attribute, for code lens placement. */
  readonly range: OffsetRange;
  readonly kind: TemplateReferenceKind;
  readonly contextKeys: readonly string[];
  /**
   * True when a context argument was present but not a literal array, so the
   * key list is known to be incomplete and must not drive a diagnostic.
   */
  readonly contextIsDynamic: boolean;
  /** Receiver variable for a method call, e.g. `this` or `twig`. */
  readonly receiver: string | undefined;
  readonly className: string | undefined;
  readonly methodName: string | undefined;
}

export interface TemplateReferenceScan {
  readonly references: readonly TemplateReference[];
  /**
   * True when the source could not be read at all. The lexer is forgiving by
   * design, so this is reserved for a genuine failure rather than for a file
   * that is merely mid-edit.
   */
  readonly parseFailed: boolean;
}

/** Tracks which class and method the walk is currently inside. */
interface Scope {
  readonly className: string | undefined;
  readonly methodName: string | undefined;
  /** Brace depth at which this scope was entered. */
  readonly depth: number;
}

export function scanTemplateReferences(source: string): TemplateReferenceScan {
  let tokens: readonly PhpToken[];
  try {
    tokens = significantTokens(source);
  } catch {
    return { references: [], parseFailed: true };
  }

  const references: TemplateReference[] = [];

  let namespaceName: string | undefined;
  let depth = 0;
  const scopes: Scope[] = [];
  let pendingClass: string | undefined;
  let pendingMethod: string | undefined;

  const currentClass = (): string | undefined => scopes.at(-1)?.className;
  const currentMethod = (): string | undefined => scopes.at(-1)?.methodName;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }

    if (token.kind === 'punctuation') {
      if (token.text === '{') {
        depth += 1;
        if (pendingClass !== undefined || pendingMethod !== undefined) {
          scopes.push({
            className: pendingClass ?? currentClass(),
            methodName: pendingMethod,
            depth,
          });
          pendingClass = undefined;
          pendingMethod = undefined;
        }
        continue;
      }
      if (token.text === '}') {
        while (scopes.length > 0 && (scopes.at(-1)?.depth ?? 0) >= depth) {
          scopes.pop();
        }
        depth -= 1;
        continue;
      }
      if (token.text === ';') {
        // An abstract or interface method never opens a brace.
        pendingMethod = undefined;
        continue;
      }
    }

    if (token.kind === 'identifier') {
      const keyword = token.text.toLowerCase();

      if (keyword === 'namespace') {
        const name = readQualifiedName(tokens, index + 1);
        if (name.text.length > 0) {
          namespaceName = name.text;
          index = name.nextIndex - 1;
        }
        continue;
      }

      if (TYPE_KEYWORDS.has(keyword)) {
        const next = tokens[index + 1];
        // `Foo::class` is not a declaration; a real one is followed by a name.
        if (next?.kind === 'identifier' && tokens[index - 1]?.text !== '::') {
          pendingClass =
            namespaceName === undefined ? next.text : `${namespaceName}\\${next.text}`;
          index += 1;
        }
        continue;
      }

      if (keyword === 'function') {
        const next = tokens[index + 1];
        if (next?.kind === 'identifier') {
          pendingMethod = next.text;
          index += 1;
        }
        continue;
      }
    }

    // `$receiver->method(` or `$receiver?->method(`
    if (token.kind === 'variable') {
      const arrow = tokens[index + 1];
      const method = tokens[index + 2];
      const open = tokens[index + 3];

      if (
        (arrow?.text === '->' || arrow?.text === '?->') &&
        method?.kind === 'identifier' &&
        open?.text === '('
      ) {
        const kind = RENDER_METHODS.get(method.text.toLowerCase());
        if (kind !== undefined) {
          const reference = readCall(tokens, index + 3, {
            kind,
            receiver: token.text.slice(1),
            className: currentClass(),
            methodName: currentMethod(),
            rangeStart: token.start,
          });
          if (reference !== undefined) {
            references.push(reference);
          }
        }
      }
      continue;
    }

    if (token.kind === 'attribute-open') {
      const reference = readAttribute(tokens, index, currentClass(), currentMethod());
      if (reference !== undefined) {
        references.push(reference);
      }
      continue;
    }
  }

  return { references, parseFailed: false };
}

interface CallContext {
  readonly kind: TemplateReferenceKind;
  readonly receiver: string | undefined;
  readonly className: string | undefined;
  readonly methodName: string | undefined;
  readonly rangeStart: number;
}

/** Reads a call's arguments, starting at the index of its opening paren. */
function readCall(
  tokens: readonly PhpToken[],
  openIndex: number,
  context: CallContext,
): TemplateReference | undefined {
  const closeIndex = findMatching(tokens, openIndex, '(', ')');
  if (closeIndex === -1) {
    return undefined;
  }

  const args = splitArguments(tokens, openIndex + 1, closeIndex);
  const templateArg = selectArgument(args, 0, TEMPLATE_ARGUMENT_NAMES);
  if (templateArg === undefined) {
    return undefined;
  }

  const literal = readSoleString(tokens, templateArg.start, templateArg.end);
  if (literal === undefined) {
    return undefined;
  }

  const contextArg = selectArgument(args, 1, CONTEXT_ARGUMENT_NAMES);
  const contextInfo =
    contextArg === undefined
      ? { keys: [], dynamic: false }
      : readContextKeys(tokens, contextArg.start, contextArg.end);

  const closeToken = tokens[closeIndex];

  return {
    templateName: literal.value ?? '',
    nameRange: { start: literal.contentStart ?? literal.start, end: literal.contentEnd ?? literal.end },
    range: { start: context.rangeStart, end: closeToken?.end ?? literal.end },
    kind: context.kind,
    contextKeys: contextInfo.keys,
    contextIsDynamic: contextInfo.dynamic,
    receiver: context.receiver,
    className: context.className,
    methodName: context.methodName,
  };
}

/** Reads `#[Template('...')]`, starting at the index of the `#[`. */
function readAttribute(
  tokens: readonly PhpToken[],
  openIndex: number,
  className: string | undefined,
  methodName: string | undefined,
): TemplateReference | undefined {
  const closeIndex = findMatching(tokens, openIndex, '[', ']');
  if (closeIndex === -1) {
    return undefined;
  }

  const name = readQualifiedName(tokens, openIndex + 1);
  if (name.text.length === 0) {
    return undefined;
  }
  const lastSegment = name.text.split('\\').pop() ?? name.text;
  if (!TEMPLATE_ATTRIBUTES.has(lastSegment.toLowerCase())) {
    return undefined;
  }

  const parenIndex = name.nextIndex;
  if (tokens[parenIndex]?.text !== '(') {
    return undefined;
  }
  const argsClose = findMatching(tokens, parenIndex, '(', ')');
  if (argsClose === -1) {
    return undefined;
  }

  const args = splitArguments(tokens, parenIndex + 1, argsClose);
  const templateArg = selectArgument(args, 0, TEMPLATE_ARGUMENT_NAMES);
  if (templateArg === undefined) {
    return undefined;
  }

  const literal = readSoleString(tokens, templateArg.start, templateArg.end);
  if (literal === undefined) {
    return undefined;
  }

  const contextArg = selectArgument(args, 1, CONTEXT_ARGUMENT_NAMES);
  const contextInfo =
    contextArg === undefined
      ? { keys: [], dynamic: false }
      : readContextKeys(tokens, contextArg.start, contextArg.end);

  return {
    templateName: literal.value ?? '',
    nameRange: { start: literal.contentStart ?? literal.start, end: literal.contentEnd ?? literal.end },
    range: { start: tokens[openIndex]?.start ?? literal.start, end: tokens[closeIndex]?.end ?? literal.end },
    kind: 'template-attribute',
    contextKeys: contextInfo.keys,
    contextIsDynamic: contextInfo.dynamic,
    receiver: undefined,
    className,
    // An attribute is written above the method it decorates, so that method
    // has not been entered yet. Look ahead for it instead.
    methodName: findDecoratedMethod(tokens, closeIndex + 1) ?? methodName,
  };
}

/** Modifiers that may sit between an attribute and the `function` it decorates. */
const METHOD_MODIFIERS: ReadonlySet<string> = new Set([
  'public',
  'protected',
  'private',
  'static',
  'final',
  'abstract',
  'readonly',
]);

/**
 * The method an attribute decorates, by scanning forward past any modifiers
 * and any further attribute groups.
 *
 * Returns undefined when the attribute decorates something that is not a
 * method, such as a class or a property, so those do not borrow a name.
 */
function findDecoratedMethod(tokens: readonly PhpToken[], start: number): string | undefined {
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      return undefined;
    }

    if (token.kind === 'attribute-open') {
      const close = findMatching(tokens, index, '[', ']');
      if (close === -1) {
        return undefined;
      }
      index = close;
      continue;
    }

    if (token.kind === 'identifier') {
      const keyword = token.text.toLowerCase();
      if (METHOD_MODIFIERS.has(keyword)) {
        continue;
      }
      if (keyword === 'function') {
        const name = tokens[index + 1];
        return name?.kind === 'identifier' ? name.text : undefined;
      }
      return undefined;
    }

    return undefined;
  }
  return undefined;
}

interface Argument {
  /** Token index of the first token, inclusive. */
  readonly start: number;
  /** Token index just past the last token. */
  readonly end: number;
  /** Present when written as `name: value`. */
  readonly name: string | undefined;
  /** Token index of the value, past any `name:` prefix. */
  readonly valueStart: number;
}

/** Splits an argument list at top-level commas. */
function splitArguments(
  tokens: readonly PhpToken[],
  start: number,
  end: number,
): readonly Argument[] {
  const args: Argument[] = [];
  let depth = 0;
  let cursor = start;

  const push = (stop: number): void => {
    if (stop > cursor) {
      args.push(describeArgument(tokens, cursor, stop));
    }
    cursor = stop + 1;
  };

  for (let index = start; index < end; index += 1) {
    const text = tokens[index]?.text ?? '';
    if (text === '(' || text === '[' || text === '{') {
      depth += 1;
    } else if (text === ')' || text === ']' || text === '}') {
      depth -= 1;
    } else if (text === ',' && depth === 0) {
      push(index);
    }
  }
  push(end);

  return args;
}

/** Detects the `name:` prefix of a PHP 8 named argument. */
function describeArgument(tokens: readonly PhpToken[], start: number, end: number): Argument {
  const first = tokens[start];
  const second = tokens[start + 1];

  // `name:` but not `Foo::BAR`, which the lexer emits as a single `::` token.
  if (first?.kind === 'identifier' && second?.text === ':') {
    return { start, end, name: first.text, valueStart: start + 2 };
  }
  return { start, end, name: undefined, valueStart: start };
}

/**
 * Picks an argument by position or by name.
 *
 * A named argument anywhere in the list wins over the positional slot, which
 * is what PHP itself does.
 */
function selectArgument(
  args: readonly Argument[],
  position: number,
  acceptedNames: ReadonlySet<string>,
): { start: number; end: number } | undefined {
  for (const arg of args) {
    if (arg.name !== undefined && acceptedNames.has(arg.name.toLowerCase())) {
      return { start: arg.valueStart, end: arg.end };
    }
  }

  const positional = args.filter((arg) => arg.name === undefined);
  const candidate = positional[position];
  return candidate === undefined ? undefined : { start: candidate.valueStart, end: candidate.end };
}

/**
 * The string token that is the whole of a span.
 *
 * Requiring it to be the only token is what rejects `'a' . $b` and
 * `$template`: a concatenation's leading fragment is not the template name,
 * and reporting it would be a confident wrong answer.
 */
function readSoleString(
  tokens: readonly PhpToken[],
  start: number,
  end: number,
): PhpToken | undefined {
  if (end - start !== 1) {
    return undefined;
  }
  const token = tokens[start];
  return token?.kind === 'string' ? token : undefined;
}

interface ContextInfo {
  readonly keys: readonly string[];
  readonly dynamic: boolean;
}

/**
 * Reads the statically known keys of a context array.
 *
 * A spread, a computed key, or a non-array argument means the real key set is
 * larger than what is visible, which is recorded so a later unknown-variable
 * check stays quiet rather than reporting a false error.
 */
function readContextKeys(
  tokens: readonly PhpToken[],
  start: number,
  end: number,
): ContextInfo {
  const open = tokens[start];
  if (open?.text !== '[' || findMatching(tokens, start, '[', ']') !== end - 1) {
    // Not a literal array: `$params`, `array(...)`, a method call, anything.
    return { keys: [], dynamic: true };
  }

  const entries = splitArguments(tokens, start + 1, end - 1);
  const keys: string[] = [];
  let dynamic = false;

  for (const entry of entries) {
    const first = tokens[entry.start];
    const second = tokens[entry.start + 1];

    if (first?.text === '...') {
      dynamic = true;
      continue;
    }
    if (first?.kind !== 'string' || second?.text !== '=>') {
      // A computed key, or a list-style entry with no key at all.
      dynamic = true;
      continue;
    }
    keys.push(first.value ?? '');
  }

  return { keys, dynamic };
}

/** Reads `Foo\Bar` or `\Foo\Bar`, returning the name and where it ended. */
function readQualifiedName(
  tokens: readonly PhpToken[],
  start: number,
): { text: string; nextIndex: number } {
  let index = start;
  let text = '';

  if (tokens[index]?.text === '\\') {
    index += 1;
  }

  while (index < tokens.length) {
    const token = tokens[index];
    if (token?.kind !== 'identifier') {
      break;
    }
    text += token.text;
    index += 1;

    if (tokens[index]?.text === '\\') {
      text += '\\';
      index += 1;
      continue;
    }
    break;
  }

  return { text, nextIndex: index };
}

/** Index of the bracket closing the one at `openIndex`, or -1. */
function findMatching(
  tokens: readonly PhpToken[],
  openIndex: number,
  open: string,
  close: string,
): number {
  let depth = 0;

  for (let index = openIndex; index < tokens.length; index += 1) {
    const text = tokens[index]?.text ?? '';
    // `#[` opens an attribute and is closed by `]`, so it counts as a square
    // bracket here even though the lexer keeps it as its own token.
    if (text === open || (open === '[' && text === '#[')) {
      depth += 1;
    } else if (text === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}
