import type { OffsetRange } from '../php/templateReferences.js';
import { javascriptTokens, stringRange } from './javascript.js';
import type { FrontendReference } from './references.js';
import { stimulusOutletProperties, stimulusOutletStem, type StimulusController, type StimulusSource } from './stimulus.js';

export function resolveOutletReference(ref: FrontendReference, controllers: readonly StimulusController[]): FrontendReference | undefined {
  if (ref.kind !== 'outlet') { return undefined; }
  if (ref.controller !== undefined) { return ref; }
  const host = longestPrefix(controllers, ref.name);
  return host ? { ...ref, controller: host.name, name: ref.name.slice(host.name.length + 1),
    range: { start: ref.range.start + host.name.length + 1, end: ref.range.end } } : undefined;
}

/**
 * The controller a template reference binds, by Stimulus' own naming rules.
 *
 * A `data-controller` names its controller outright. A value, class or outlet
 * attribute names it only as a prefix of its own name, and two identifiers can
 * both be prefixes of one attribute, so the longest wins: `user-card-url`
 * belongs to `user-card` and not to `user`.
 */
export function controllerForReference(ref: FrontendReference,
  controllers: readonly StimulusController[]): StimulusController | undefined {
  const named = ref.kind === 'controller' ? ref.name
    : resolveOutletReference(ref, controllers)?.controller ?? ref.controller;
  if (named !== undefined) { return byName(controllers).get(named); }
  if (!['value', 'class'].includes(ref.kind)) { return undefined; }
  return longestPrefix(controllers, ref.name);
}

/**
 * The longest identifier the name begins with, or nothing.
 *
 * Scanning the list in longest-first order stops at the first match instead of
 * collecting every candidate and sorting them, which matters because this runs
 * once per attribute in every indexed template.
 */
function longestPrefix(controllers: readonly StimulusController[], name: string): StimulusController | undefined {
  return byLength(controllers).find((controller) => name.startsWith(`${controller.name}-`));
}

/** Derived once per controller list; the list is replaced wholesale on every
 * rediscovery, so holding it by identity cannot go stale. */
const names = new WeakMap<readonly StimulusController[], ReadonlyMap<string, StimulusController>>();
const lengths = new WeakMap<readonly StimulusController[], readonly StimulusController[]>();

function byName(controllers: readonly StimulusController[]): ReadonlyMap<string, StimulusController> {
  let found = names.get(controllers);
  if (found === undefined) {
    found = new Map(controllers.map((controller) => [controller.name, controller]));
    names.set(controllers, found);
  }
  return found;
}

function byLength(controllers: readonly StimulusController[]): readonly StimulusController[] {
  let found = lengths.get(controllers);
  if (found === undefined) {
    found = [...controllers].sort((left, right) => right.name.length - left.name.length);
    lengths.set(controllers, found);
  }
  return found;
}

export interface OutletAccess {
  readonly kind: 'declaration' | 'property' | 'method' | 'callback';
  readonly name: string;
  readonly range: OffsetRange;
  readonly outlet?: string;
}

export function outletAccessAt(source: string, info: StimulusSource, offset: number): OutletAccess | undefined {
  if (info.outletsRange && contains(info.outletsRange, offset)) {
    const token = javascriptTokens(source, info.outletsRange.start, info.outletsRange.end)
      .find((token) => token.kind === 'string' && contains(stringRange(token), offset));
    if (token) { return { kind: 'declaration', name: token.value ?? '', range: stringRange(token) }; }
  }
  const callback = info.outletCallbacks.find((member) => contains(member.range, offset));
  if (callback) {
    const outlet = info.outlets.find((member) => [`${stimulusOutletStem(member.name)}OutletConnected`,
      `${stimulusOutletStem(member.name)}OutletDisconnected`].includes(callback.name));
    if (outlet) { return { ...callback, kind: 'callback', outlet: outlet.name }; }
  }
  const access = info.accesses.find((member) => contains(member.range, offset));
  if (!access) { return undefined; }
  if (access.receiver) {
    const outlet = info.outlets.find((member) => `${stimulusOutletStem(member.name)}Outlet` === access.receiver);
    return outlet ? { ...access, kind: 'method', outlet: outlet.name } : undefined;
  }
  if (!info.outlets.length) { return undefined; }
  return { ...access, kind: 'property' };
}

export function outletUseRanges(info: StimulusSource, name: string): readonly OffsetRange[] {
  const properties = stimulusOutletProperties(name), stem = stimulusOutletStem(name);
  return [...info.accesses.filter((member) => !member.receiver && properties.includes(member.name)),
    ...info.outletCallbacks.filter((member) => [`${stem}OutletConnected`, `${stem}OutletDisconnected`].includes(member.name))]
    .map((member) => member.range);
}

function contains(range: OffsetRange, offset: number): boolean { return offset >= range.start && offset <= range.end; }
