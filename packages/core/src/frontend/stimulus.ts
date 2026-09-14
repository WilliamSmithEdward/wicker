import type { OffsetRange } from '../php/templateReferences.js';
import { closingToken, javascriptTokens, stringRange, type JsToken } from './javascript.js';

export interface StimulusMember { readonly name: string; readonly range: OffsetRange }
export interface StimulusAccess extends StimulusMember { readonly receiver?: string }
export interface StimulusValue extends StimulusMember {
  /**
   * `String`, `Number`, `Boolean`, `Array` or `Object` as written.
   *
   * Stimulus uses the type to convert the data attribute, so it decides what
   * `this.xValue` actually is. Absent when the declaration computes it.
   */
  readonly type?: string;
  /** The default as written, when the object form supplies one. */
  readonly defaultText?: string;
}
export interface StimulusDispatch extends StimulusMember {
  /**
   * True when the emitted event is `<identifier>:<name>`.
   *
   * Stimulus prefixes a dispatched event with the controller identifier unless
   * the call passes a `prefix` option. That option's value is not read, so a
   * call carrying one records the name but makes no claim about the event a
   * listener would bind, which is better than composing the wrong one.
   */
  readonly defaultPrefix: boolean;
}
export interface StimulusSource {
  readonly range: OffsetRange;
  /**
   * The class body's braces, so an edit can add a member.
   *
   * Absent when no controller class was found, which is what tells a caller
   * there is nowhere to put one.
   */
  readonly bodyRange?: OffsetRange;
  readonly actions: readonly StimulusMember[];
  readonly targets: readonly StimulusMember[];
  readonly values: readonly StimulusValue[];
  readonly outlets: readonly StimulusMember[];
  /** Logical names from `static classes`, not the CSS classes they map to. */
  readonly classes: readonly StimulusMember[];
  /** Events the controller emits through `this.dispatch(...)`. */
  readonly dispatches: readonly StimulusDispatch[];
  readonly outletsRange?: OffsetRange;
  readonly outletCallbacks: readonly StimulusMember[];
  readonly accesses: readonly StimulusAccess[];
}
export interface StimulusController { readonly name: string; readonly projectPath: string }

/** The only types Stimulus converts a value attribute to. */
export const VALUE_TYPES: readonly string[] = ['String', 'Number', 'Boolean', 'Array', 'Object'];

export function stimulusIdentifier(relativePath: string): string | undefined {
  if (!/[-_]controller\.[jt]s$/.test(relativePath)) { return undefined; }
  return relativePath.replace(/[-_]controller\.[jt]s$/, '').replaceAll('_', '-').replaceAll('/', '--');
}

/** Direct members of the default exported class only. Inheritance, computed
 * declarations and runtime registrations deliberately remain unknown. */
export function stimulusSource(source: string): StimulusSource {
  const tokens = javascriptTokens(source);
  const empty = { range: { start: 0, end: 0 }, actions: [], targets: [], values: [], outlets: [], classes: [], dispatches: [], outletCallbacks: [], accesses: [] };
  const exported = tokens.findIndex((t, i) => t.text === 'export' && tokens[i + 1]?.text === 'default');
  if (exported < 0) { return empty; }
  let klass = exported + 2;
  if (tokens[klass]?.text !== 'class') {
    const name = tokens[klass]?.text;
    klass = tokens.findIndex((t, i) => t.text === 'class' && tokens[i + 1]?.text === name);
  }
  if (klass < 0 || tokens[klass]?.text !== 'class') { return empty; }
  const open = tokens.findIndex((t, i) => i > klass && t.text === '{');
  const close = closingToken(tokens, open);
  if (close < 0) { return empty; }
  const actions: StimulusMember[] = [], targets: StimulusMember[] = [], values: StimulusValue[] = [];
  const outlets: StimulusMember[] = [], classes: StimulusMember[] = [], outletCallbacks: StimulusMember[] = [];
  const staticBodies: OffsetRange[] = [];
  let outletsRange: OffsetRange | undefined;
  const lifecycle = new Set(['constructor', 'initialize', 'connect', 'disconnect']);
  for (let i = open + 1; i < close; i++) {
    const t = tokens[i]!;
    if (t.text === 'static' && ['targets', 'values', 'outlets', 'classes'].includes(tokens[i + 1]?.text ?? '') && tokens[i + 2]?.text === '=') {
      const kind = tokens[i + 1]!.text;
      const from = i + 3, end = closingToken(tokens, from);
      if (end < 0) { continue; }
      if (kind === 'outlets' && tokens[from]?.text === '[') { outletsRange = { start: tokens[from].end, end: tokens[end]!.start }; }
      for (let j = from + 1; j < end; j++) {
        const member = tokens[j]!;
        if (['targets', 'outlets', 'classes'].includes(kind) && tokens[from]?.text === '[' && member.kind === 'string' && ['[', ','].includes(tokens[j - 1]?.text ?? '') &&
          [',', ']'].includes(tokens[j + 1]?.text ?? '') && member.value) {
          const into = kind === 'outlets' ? outlets : kind === 'classes' ? classes : targets;
          into.push({ name: member.value, range: stringRange(member) });
        }
        if (kind === 'values' && ['name', 'string'].includes(member.kind) && tokens[j + 1]?.text === ':' &&
          ['{', ','].includes(tokens[j - 1]?.text ?? '')) {
          values.push({ name: member.value ?? member.text, range: member.kind === 'string' ? stringRange(member) : member,
            ...valueShape(source, tokens, j + 2, end) });
        }
        if (['{', '[', '('].includes(member.text)) { const nested = closingToken(tokens, j); if (nested >= 0) { j = nested; } }
      }
      i = end;
      continue;
    }
    if (t.kind === 'name' && tokens[i + 1]?.text === '(') {
      const args = closingToken(tokens, i + 1);
      let body = args + 1;
      // Return type annotations may precede a method body.
      if (tokens[body]?.text === ':') { while (body < close && !['{', ';', '='].includes(tokens[body]?.text ?? '')) { body++; } }
      if (args >= 0 && tokens[body]?.text === '{') {
        const modifiers: string[] = [];
        for (let j = i - 1; j > open && ![';', '}', '{'].includes(tokens[j]!.text); j--) { modifiers.push(tokens[j]!.text); }
        const instance = !modifiers.some((m) => ['#', 'private', 'protected', 'static', '='].includes(m));
        if (instance && /(?:OutletConnected|OutletDisconnected)$/.test(t.text)) { outletCallbacks.push({ name: t.text, range: t }); }
        if (!lifecycle.has(t.text) && !/(?:TargetConnected|TargetDisconnected|ValueChanged|OutletConnected|OutletDisconnected)$/.test(t.text) &&
          !modifiers.some((m) => ['#', 'private', 'protected', 'static', 'get', 'set', '='].includes(m))) {
          actions.push({ name: t.text, range: t });
        }
        const end = closingToken(tokens, body);
        if (end >= 0 && modifiers.includes('static')) { staticBodies.push({ start: tokens[body]!.start, end: tokens[end]!.end }); }
        if (end >= 0) { i = end; }
        continue;
      }
    }
    if (['{', '[', '('].includes(t.text)) { const end = closingToken(tokens, i); if (end >= 0) { i = end; } }
  }
  const accesses: StimulusAccess[] = [];
  const dispatches: StimulusDispatch[] = [];
  for (let i = open + 1; i < close; i++) {
    const token = tokens[i]!;
    if (staticBodies.some((range) => token.start >= range.start && token.end <= range.end)) { continue; }
    // A nested ordinary function or class has its own `this`. Arrow functions
    // retain the controller's `this` and remain useful connections.
    if (['function', 'class'].includes(token.text)) {
      let body = i + 1;
      while (body < close && tokens[body]?.text !== '{') { body++; }
      const end = closingToken(tokens, body);
      if (end >= 0) { i = end; continue; }
    }
    if (token.text !== 'this' || !['.', '?.'].includes(tokens[i + 1]?.text ?? '')) { continue; }
    const property = tokens[i + 2];
    accesses.push(property?.kind === 'name' ? { name: property.text, range: property }
      : { name: '', range: { start: tokens[i + 1]!.end, end: tokens[i + 1]!.end } });
    if (property?.text === 'dispatch' && tokens[i + 3]?.text === '(') {
      const emitted = tokens[i + 4];
      const args = closingToken(tokens, i + 3);
      if (emitted?.kind === 'string' && emitted.value !== undefined && args > 0) {
        const options = tokens.slice(i + 5, args);
        dispatches.push({ name: emitted.value, range: stringRange(emitted),
          defaultPrefix: !options.some((option) => option.text === 'prefix') });
      }
    }
    if (property?.kind === 'name' && ['.', '?.'].includes(tokens[i + 3]?.text ?? '')) {
      const member = tokens[i + 4];
      accesses.push({ receiver: property.text, ...(member?.kind === 'name' ? { name: member.text, range: member }
        : { name: '', range: { start: tokens[i + 3]!.end, end: tokens[i + 3]!.end } }) });
    }
  }
  return { range: tokens[klass]!, bodyRange: { start: tokens[open]!.start, end: tokens[close]!.end },
    actions, targets, values,
    outlets, classes, dispatches, ...(outletsRange ? { outletsRange } : {}), outletCallbacks, accesses };
}

/** Stimulus removes namespace separators when generating outlet accessors. */
export function stimulusOutletStem(identifier: string): string {
  return identifier.replaceAll('--', '-').replace(/[_-](\w|$)/g, (_, letter: string) => letter.toUpperCase());
}

export function stimulusOutletProperties(identifier: string): readonly string[] {
  const stem = stimulusOutletStem(identifier);
  return [`${stem}Outlet`, `${stem}Outlets`, `${stem}OutletElement`, `${stem}OutletElements`,
    `has${stem.charAt(0).toUpperCase()}${stem.slice(1)}Outlet`];
}

/** `output` becomes `this.outputTarget`, and the plural and presence forms. */
export function stimulusTargetProperties(name: string): readonly string[] {
  return [`${name}Target`, `${name}Targets`, `has${capitalize(name)}Target`];
}

/** `statusUrl` becomes `this.statusUrlValue` and `this.hasStatusUrlValue`. */
export function stimulusValueProperties(name: string): readonly string[] {
  return [`${name}Value`, `has${capitalize(name)}Value`];
}

export interface GeneratedMember {
  /** The property as written in JavaScript, such as `statusUrlValue`. */
  readonly name: string;
  readonly kind: 'target' | 'value' | 'class' | 'outlet';
  /** The declaration it comes from, for navigation back to the source. */
  readonly declaration: StimulusMember;
}

/**
 * Every property Stimulus generates from a controller's declarations.
 *
 * These exist only at runtime: nothing declares `statusUrlValue`, so an editor
 * reading the file sees an unknown property and a typo in one is invisible
 * until the page runs. Target and value names are used verbatim, while class
 * and outlet names are camel-cased, because those two may contain dashes.
 */
export function stimulusGeneratedMembers(source: StimulusSource): readonly GeneratedMember[] {
  const groups: readonly [readonly StimulusMember[], GeneratedMember['kind'], (name: string) => readonly string[]][] = [
    [source.targets, 'target', stimulusTargetProperties],
    [source.values, 'value', stimulusValueProperties],
    [source.classes, 'class', stimulusClassProperties],
    [source.outlets, 'outlet', stimulusOutletProperties],
  ];
  return groups.flatMap(([members, kind, properties]) =>
    members.flatMap((declaration) => properties(declaration.name)
      .map((name) => ({ name, kind, declaration }))));
}

function capitalize(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/**
 * The declared member names in a controller, for an editor to mark.
 *
 * To a JavaScript grammar these are an object key and two array entries, so
 * nothing distinguishes them from any other literal. Each one is really a
 * declaration: Stimulus generates accessors and presence checks from it, and
 * the same name appears in Twig as a data attribute. Only the declarations are
 * returned, never the types beside them or the members' later uses, so marking
 * these claims no more than the source states.
 */
export function stimulusDeclarationRanges(source: StimulusSource): readonly OffsetRange[] {
  return [...source.values, ...source.targets, ...source.outlets, ...source.classes]
    .map((member) => member.range)
    .sort((left, right) => left.start - right.start);
}

/**
 * The properties Stimulus generates for a logical CSS class name.
 *
 * `static classes = ['loading']` does not declare a CSS class called loading.
 * It declares a slot the template fills through `data-<identifier>-loading-class`,
 * read back through these. That indirection is the reason a logical name is
 * worth telling apart from an ordinary class attribute.
 */
export function stimulusClassProperties(name: string): readonly string[] {
  const stem = name.replace(/[_-](\w|$)/g, (_, letter: string) => letter.toUpperCase());
  return [`${stem}Class`, `${stem}Classes`, `has${stem.charAt(0).toUpperCase()}${stem.slice(1)}Class`];
}

/**
 * The type and default of one value declaration.
 *
 * Two forms are legal: `url: String` names only the type, and
 * `count: { type: Number, default: 1 }` supplies both. The default is taken as
 * written, since showing the source text says more than a parsed
 * approximation and cannot misreport it.
 */
function valueShape(source: string, tokens: readonly JsToken[], at: number,
  limit: number): { type?: string; defaultText?: string } {
  const first = tokens[at];
  if (first === undefined || at >= limit) { return {}; }
  if (first.text !== '{') {
    // A name that is not one of the five constructors is a variable holding
    // one. Which it holds cannot be read here, so no type is claimed.
    return VALUE_TYPES.includes(first.text) ? { type: first.text } : {};
  }

  const close = closingToken(tokens, at);
  if (close < 0) { return {}; }
  const shape: { type?: string; defaultText?: string } = {};
  for (let i = at + 1; i < close; i++) {
    const key = tokens[i]!;
    if (key.kind !== 'name' || tokens[i + 1]?.text !== ':') { continue; }
    const value = tokens[i + 2];
    if (value === undefined) { break; }
    if (key.text === 'type' && VALUE_TYPES.includes(value.text)) { shape.type = value.text; }
    if (key.text === 'default') {
      // A default may be an array or object literal, so the whole expression
      // is taken verbatim rather than just its first token.
      const nested = ['{', '['].includes(value.text) ? closingToken(tokens, i + 2) : -1;
      shape.defaultText = source.slice(value.start, nested >= 0 ? tokens[nested]!.end : value.end);
    }
    if (['{', '[', '('].includes(value.text)) {
      const nested = closingToken(tokens, i + 2);
      if (nested >= 0) { i = nested; continue; }
    }
    i += 2;
  }
  return shape;
}
