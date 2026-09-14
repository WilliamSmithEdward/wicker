import type { OffsetRange } from '../php/templateReferences.js';
import { closingToken, javascriptTokens, stringRange } from './javascript.js';

export interface StimulusMember { readonly name: string; readonly range: OffsetRange }
export interface StimulusAccess extends StimulusMember { readonly receiver?: string }
export interface StimulusSource {
  readonly range: OffsetRange;
  readonly actions: readonly StimulusMember[];
  readonly targets: readonly StimulusMember[];
  readonly values: readonly StimulusMember[];
  readonly outlets: readonly StimulusMember[];
  /** Logical names from `static classes`, not the CSS classes they map to. */
  readonly classes: readonly StimulusMember[];
  readonly outletsRange?: OffsetRange;
  readonly outletCallbacks: readonly StimulusMember[];
  readonly accesses: readonly StimulusAccess[];
}
export interface StimulusController { readonly name: string; readonly projectPath: string }

export function stimulusIdentifier(relativePath: string): string | undefined {
  if (!/[-_]controller\.[jt]s$/.test(relativePath)) { return undefined; }
  return relativePath.replace(/[-_]controller\.[jt]s$/, '').replaceAll('_', '-').replaceAll('/', '--');
}

/** Direct members of the default exported class only. Inheritance, computed
 * declarations and runtime registrations deliberately remain unknown. */
export function stimulusSource(source: string): StimulusSource {
  const tokens = javascriptTokens(source);
  const empty = { range: { start: 0, end: 0 }, actions: [], targets: [], values: [], outlets: [], classes: [], outletCallbacks: [], accesses: [] };
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
  const actions: StimulusMember[] = [], targets: StimulusMember[] = [], values: StimulusMember[] = [];
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
          values.push({ name: member.value ?? member.text, range: member.kind === 'string' ? stringRange(member) : member });
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
    if (property?.kind === 'name' && ['.', '?.'].includes(tokens[i + 3]?.text ?? '')) {
      const member = tokens[i + 4];
      accesses.push({ receiver: property.text, ...(member?.kind === 'name' ? { name: member.text, range: member }
        : { name: '', range: { start: tokens[i + 3]!.end, end: tokens[i + 3]!.end } }) });
    }
  }
  return { range: tokens[klass]!, actions, targets, values,
    outlets, classes, ...(outletsRange ? { outletsRange } : {}), outletCallbacks, accesses };
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
