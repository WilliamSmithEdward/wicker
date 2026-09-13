/**
 * Finding the places PHP names a Twig template.
 *
 * This is the controller half of the bridge. A Symfony controller refers to its
 * template as a bare string, so without this the editor sees an ordinary string
 * literal and the connection is invisible.
 *
 * Positions are returned as byte-free character offsets into the source rather
 * than line and column pairs. The editor layer converts them using the
 * document's own line index, which keeps UTF-16 column arithmetic where the
 * document lives instead of duplicating it here.
 */

// php-parser's runtime exports the constructor both directly and as `.Engine`;
// the named form is the one its shipped types declare.
import { Engine } from 'php-parser';

/** A half-open character range within the scanned source. */
export interface OffsetRange {
  readonly start: number;
  readonly end: number;
}

export type TemplateReferenceKind =
  /** `$this->render(...)` and friends inside a controller. */
  | 'render'
  | 'renderView'
  | 'renderBlock'
  | 'renderBlockView'
  | 'renderForm'
  | 'stream'
  /** The `#[Template('...')]` attribute on a controller action. */
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

/**
 * Attribute names that carry a template. Matched on the trailing segment so
 * both `#[Template]` and `#[Bridge\Twig\Attribute\Template]` are recognised.
 */
const TEMPLATE_ATTRIBUTES: ReadonlySet<string> = new Set(['template']);

/** Named argument that carries the template name, for PHP 8 call sites. */
const TEMPLATE_ARGUMENT_NAMES: ReadonlySet<string> = new Set(['view', 'template', 'name']);

/** Named argument that carries the context array. */
const CONTEXT_ARGUMENT_NAMES: ReadonlySet<string> = new Set([
  'parameters',
  'context',
  'variables',
  'data',
]);

export interface TemplateReference {
  /** The template name exactly as written, with escapes already decoded. */
  readonly templateName: string;
  /** Offsets of the name itself, inside the quotes. */
  readonly nameRange: OffsetRange;
  /** Offsets of the whole call or attribute, for code lens placement. */
  readonly range: OffsetRange;
  readonly kind: TemplateReferenceKind;
  /** Statically known keys of the context array passed alongside. */
  readonly contextKeys: readonly string[];
  /**
   * True when a context argument was present but not a literal array, so the
   * key list is known to be incomplete and must not drive a diagnostic.
   */
  readonly contextIsDynamic: boolean;
  /** Receiver variable for a method call, e.g. `this` or `twig`. */
  readonly receiver: string | undefined;
  /** Fully qualified enclosing class, when the file declares one. */
  readonly className: string | undefined;
  readonly methodName: string | undefined;
}

export interface TemplateReferenceScan {
  readonly references: readonly TemplateReference[];
  /**
   * True when the file could not be parsed at all. Callers should keep any
   * previous result rather than treating the file as having no references,
   * because a file is unparseable for most of the time it is being typed.
   */
  readonly parseFailed: boolean;
}

const EMPTY_SCAN: TemplateReferenceScan = { references: [], parseFailed: true };

/** Minimal shape of the php-parser nodes this module reads. */
interface PhpNode {
  kind: string;
  loc?: { start: { offset: number }; end: { offset: number } };
  [key: string]: unknown;
}

/**
 * Scans PHP source for every reference to a Twig template.
 *
 * Never throws: a syntax error yields `parseFailed`, and anything unrecognised
 * is skipped rather than guessed at.
 */
export function scanTemplateReferences(source: string): TemplateReferenceScan {
  let ast: PhpNode;
  try {
    const parser = new Engine({
      parser: { extractDoc: false, suppressErrors: true, version: 805 },
      ast: { withPositions: true },
    });
    ast = parser.parseCode(source, 'scan.php') as unknown as PhpNode;
  } catch {
    return EMPTY_SCAN;
  }

  const references: TemplateReference[] = [];
  walk(ast, { namespace: undefined, className: undefined, methodName: undefined });
  return { references, parseFailed: false };

  function walk(node: unknown, context: WalkContext): void {
    if (node === null || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        walk(child, context);
      }
      return;
    }

    const current = node as PhpNode;
    const nextContext = extendContext(current, context);

    if (current.kind === 'call') {
      collectFromCall(current, nextContext, references);
    } else if (current.kind === 'attribute') {
      collectFromAttribute(current, nextContext, references);
    }

    for (const key of Object.keys(current)) {
      if (key === 'loc') {
        continue;
      }
      walk(current[key], nextContext);
    }
  }
}

interface WalkContext {
  namespace: string | undefined;
  className: string | undefined;
  methodName: string | undefined;
}

function extendContext(node: PhpNode, context: WalkContext): WalkContext {
  switch (node.kind) {
    case 'namespace': {
      const name = readIdentifier(node['name']);
      return { ...context, namespace: name };
    }
    case 'class':
    case 'interface':
    case 'trait':
    case 'enum': {
      const name = readIdentifier(node['name']);
      if (name === undefined) {
        return context;
      }
      const qualified =
        context.namespace === undefined ? name : `${context.namespace}\\${name}`;
      return { ...context, className: qualified };
    }
    case 'method':
    case 'function': {
      return { ...context, methodName: readIdentifier(node['name']) };
    }
    default:
      return context;
  }
}

function collectFromCall(
  node: PhpNode,
  context: WalkContext,
  into: TemplateReference[],
): void {
  const what = node['what'];
  if (!isNode(what) || (what.kind !== 'propertylookup' && what.kind !== 'nullsafepropertylookup')) {
    return;
  }

  const methodName = readIdentifier(what['offset']);
  if (methodName === undefined) {
    return;
  }
  const kind = RENDER_METHODS.get(methodName.toLowerCase());
  if (kind === undefined) {
    return;
  }

  const args = node['arguments'];
  if (!Array.isArray(args)) {
    return;
  }

  const templateArgument = selectArgument(args, 0, TEMPLATE_ARGUMENT_NAMES);
  if (templateArgument === undefined) {
    return;
  }
  const literal = readStringLiteral(templateArgument);
  if (literal === undefined) {
    return;
  }

  const contextArgument = selectArgument(args, 1, CONTEXT_ARGUMENT_NAMES);
  const contextInfo = readContextKeys(contextArgument);

  const receiverNode = what['what'];
  const receiver = isNode(receiverNode) && receiverNode.kind === 'variable'
    ? readIdentifier(receiverNode['name'])
    : undefined;

  into.push({
    templateName: literal.value,
    nameRange: literal.range,
    range: rangeOf(node) ?? literal.range,
    kind,
    contextKeys: contextInfo.keys,
    contextIsDynamic: contextInfo.dynamic,
    receiver,
    className: context.className,
    methodName: context.methodName,
  });
}

function collectFromAttribute(
  node: PhpNode,
  context: WalkContext,
  into: TemplateReference[],
): void {
  const rawName = typeof node['name'] === 'string' ? node['name'] : readIdentifier(node['name']);
  if (rawName === undefined) {
    return;
  }
  const lastSegment = rawName.split('\\').pop() ?? rawName;
  if (!TEMPLATE_ATTRIBUTES.has(lastSegment.toLowerCase())) {
    return;
  }

  const args = node['args'];
  if (!Array.isArray(args)) {
    return;
  }

  const templateArgument = selectArgument(args, 0, TEMPLATE_ARGUMENT_NAMES);
  if (templateArgument === undefined) {
    return;
  }
  const literal = readStringLiteral(templateArgument);
  if (literal === undefined) {
    return;
  }

  const contextArgument = selectArgument(args, 1, CONTEXT_ARGUMENT_NAMES);
  const contextInfo = readContextKeys(contextArgument);

  into.push({
    templateName: literal.value,
    nameRange: literal.range,
    range: rangeOf(node) ?? literal.range,
    kind: 'template-attribute',
    contextKeys: contextInfo.keys,
    contextIsDynamic: contextInfo.dynamic,
    receiver: undefined,
    className: context.className,
    methodName: context.methodName,
  });
}

/**
 * Picks an argument by position or by name.
 *
 * php-parser represents a positional argument as the value node itself and a
 * named one as a `namedargument` wrapper, so both forms are unwrapped here.
 * A named argument anywhere in the list wins over the positional slot, which
 * is what PHP itself does.
 */
function selectArgument(
  args: readonly unknown[],
  position: number,
  acceptedNames: ReadonlySet<string>,
): PhpNode | undefined {
  for (const arg of args) {
    if (!isNode(arg) || arg.kind !== 'namedargument') {
      continue;
    }
    const name = typeof arg['name'] === 'string' ? arg['name'] : readIdentifier(arg['name']);
    if (name !== undefined && acceptedNames.has(name.toLowerCase())) {
      const value = arg['value'];
      return isNode(value) ? value : undefined;
    }
  }

  const positional = args.filter((arg) => !(isNode(arg) && arg.kind === 'namedargument'));
  const candidate = positional[position];
  return isNode(candidate) ? candidate : undefined;
}

interface StringLiteral {
  readonly value: string;
  readonly range: OffsetRange;
}

/**
 * Reads a plain string literal and the offsets of its contents.
 *
 * The node's own range covers the quotes, so the inner range is derived from
 * the raw text. Interpolated strings are rejected: their value is not known
 * statically and offering navigation from one would be a guess.
 */
function readStringLiteral(node: PhpNode): StringLiteral | undefined {
  if (node.kind !== 'string') {
    return undefined;
  }
  const value = node['value'];
  const raw = node['raw'];
  if (typeof value !== 'string' || typeof raw !== 'string') {
    return undefined;
  }
  const outer = rangeOf(node);
  if (outer === undefined) {
    return undefined;
  }

  // A double-quoted string containing an interpolation is parsed as an
  // `encapsed` node, not a `string`, so reaching here means the text is
  // literal. Heredoc bodies still arrive as strings whose raw text carries a
  // multi-character opener, so the delimiter length is measured rather than
  // assumed to be one quote.
  const openingLength = measureOpeningDelimiter(raw);
  if (openingLength === undefined) {
    return undefined;
  }
  const closingLength = measureClosingDelimiter(raw, openingLength);

  return {
    value,
    range: {
      start: outer.start + openingLength,
      end: Math.max(outer.start + openingLength, outer.end - closingLength),
    },
  };
}

/** Length of a literal's opening delimiter, or undefined if unrecognised. */
function measureOpeningDelimiter(raw: string): number | undefined {
  if (raw.startsWith("'") || raw.startsWith('"')) {
    return 1;
  }
  if (raw.startsWith('b"') || raw.startsWith("b'") || raw.startsWith('B"') || raw.startsWith("B'")) {
    return 2;
  }
  // Heredoc and nowdoc openers run to the end of their first line.
  const heredoc = /^<<<(['"]?)[A-Za-z_][A-Za-z0-9_]*\1\r?\n/.exec(raw);
  if (heredoc !== null) {
    return heredoc[0].length;
  }
  return undefined;
}

/** Length of the closing delimiter that matches a measured opener. */
function measureClosingDelimiter(raw: string, openingLength: number): number {
  if (raw.startsWith('<<<')) {
    // The closer is a newline plus the label; derive it from what remains.
    const closer = /\r?\n[ \t]*[A-Za-z_][A-Za-z0-9_]*$/.exec(raw);
    return closer === null ? 0 : closer[0].length;
  }
  return openingLength === 2 ? 1 : openingLength;
}

interface ContextInfo {
  readonly keys: readonly string[];
  readonly dynamic: boolean;
}

const NO_CONTEXT: ContextInfo = { keys: [], dynamic: false };

/**
 * Reads the statically known keys of a context array.
 *
 * A spread, a variable key, or a non-array argument means the real key set is
 * larger than what is visible, which is recorded so that a later
 * unknown-variable check knows to stay quiet rather than report a false error.
 */
function readContextKeys(node: PhpNode | undefined): ContextInfo {
  if (node === undefined) {
    return NO_CONTEXT;
  }
  if (node.kind !== 'array') {
    return { keys: [], dynamic: true };
  }

  const items = node['items'];
  if (!Array.isArray(items)) {
    return { keys: [], dynamic: true };
  }

  const keys: string[] = [];
  let dynamic = false;
  for (const item of items) {
    if (!isNode(item)) {
      continue;
    }
    if (item.kind === 'spread' || item['byRef'] === true) {
      dynamic = true;
      continue;
    }
    if (item.kind !== 'entry') {
      dynamic = true;
      continue;
    }
    const key = item['key'];
    if (!isNode(key)) {
      // A list-style entry with no key cannot name a template variable.
      dynamic = true;
      continue;
    }
    if (key.kind !== 'string' || typeof key['value'] !== 'string') {
      dynamic = true;
      continue;
    }
    keys.push(key['value']);
  }

  return { keys, dynamic };
}

function isNode(value: unknown): value is PhpNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { kind?: unknown }).kind === 'string'
  );
}

/** php-parser stores an identifier as a node with a name, or as a bare string. */
function readIdentifier(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (isNode(value) && typeof value['name'] === 'string') {
    return value['name'];
  }
  return undefined;
}

function rangeOf(node: PhpNode): OffsetRange | undefined {
  const loc = node.loc;
  if (loc === undefined) {
    return undefined;
  }
  return { start: loc.start.offset, end: loc.end.offset };
}
