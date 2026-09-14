/**
 * The parts of a Stimulus action descriptor.
 *
 *     keydown.enter@window->search#submit:prevent
 *     ^^^^^^^ ^^^^^ ^^^^^^  ^^^^^^ ^^^^^^ ^^^^^^^
 *     event   filter target  ctrl   method option
 *
 * Only the controller and method halves were ever read, which left the more
 * error-prone half invisible. A mistyped event name, a key filter Stimulus
 * does not know, or an option spelled wrong all fail silently: the listener is
 * simply never attached, with nothing in any log.
 *
 * The vocabularies here are Stimulus's own and cannot be discovered from a
 * project, so they are listed rather than derived. Events are open-ended, since
 * any DOM event and any custom dispatched name is legal, so the list is for
 * completion and never for a warning.
 */

import type { OffsetRange } from '../php/templateReferences.js';

export interface DescriptorPart {
  readonly name: string;
  readonly range: OffsetRange;
}

export interface ActionDescriptor {
  /** Absent when the descriptor relies on the element's default event. */
  readonly event?: DescriptorPart;
  /** The `.enter` of `keydown.enter`. */
  readonly keyFilter?: DescriptorPart;
  /** `window` or `document`, from the `@` suffix. */
  readonly eventTarget?: DescriptorPart;
  readonly options: readonly DescriptorPart[];
}

/** Events Stimulus attaches by default, keyed by the element they appear on. */
export const DEFAULT_EVENTS: Readonly<Record<string, string>> = {
  a: 'click', button: 'click', details: 'toggle', form: 'submit',
  input: 'input', select: 'change', textarea: 'input',
};

/** Commonly bound DOM events, offered for completion only. */
export const COMMON_EVENTS: readonly string[] = [
  'click', 'dblclick', 'mousedown', 'mouseup', 'mouseenter', 'mouseleave', 'mousemove',
  'keydown', 'keyup', 'keypress', 'input', 'change', 'submit', 'reset', 'focus', 'blur',
  'focusin', 'focusout', 'scroll', 'resize', 'toggle', 'drop', 'dragover', 'dragstart',
  'touchstart', 'touchend', 'touchmove', 'pointerdown', 'pointerup', 'wheel',
];

/** Key filter names Stimulus recognises after a keyboard event. */
export const KEY_FILTERS: readonly string[] = [
  'enter', 'tab', 'esc', 'space', 'up', 'down', 'left', 'right', 'home', 'end',
  'page_up', 'page_down', 'a', 'ctrl', 'alt', 'shift', 'meta',
];

/** Where a global listener may be attached instead of the element. */
export const EVENT_TARGETS: readonly string[] = ['window', 'document'];

/** Action options, each written after a colon. */
export const ACTION_OPTIONS: readonly string[] = [
  'prevent', 'stop', 'self', 'once', 'passive', '!passive', 'capture',
];

/**
 * Splits one descriptor, given its text and the offset that text starts at.
 *
 * The controller and method are deliberately not returned: they are already
 * resolved against the project elsewhere, and duplicating that here would give
 * two answers to one question.
 */
export function parseActionDescriptor(text: string, offset: number): ActionDescriptor {
  const arrow = text.indexOf('->');
  const options: DescriptorPart[] = [];

  // Options follow the method, so they are found after the arrow when there is
  // one and after the `#` otherwise.
  const methodStart = arrow < 0 ? text.indexOf('#') + 1 : text.indexOf('#', arrow) + 1;
  if (methodStart > 0) {
    let cursor = text.indexOf(':', methodStart);
    while (cursor >= 0) {
      const next = text.indexOf(':', cursor + 1);
      const end = next < 0 ? text.length : next;
      options.push({ name: text.slice(cursor + 1, end), range: { start: offset + cursor + 1, end: offset + end } });
      cursor = next;
    }
  }

  const hash = text.indexOf('#');
  // Mid-edit there is no arrow yet. A dot or an at sign before any `#` cannot
  // occur in a controller identifier, which is lowercase, digits and dashes,
  // so text containing one is the event half being typed rather than a
  // default-event descriptor.
  const headEnd = arrow >= 0 ? arrow : hash < 0 ? text.length : hash;
  if (arrow < 0 && !/[.@]/.test(text.slice(0, headEnd))) {
    return { options };
  }

  let head = text.slice(0, headEnd);
  let eventTarget: DescriptorPart | undefined;

  const at = head.indexOf('@');
  if (at >= 0) {
    eventTarget = { name: head.slice(at + 1), range: { start: offset + at + 1, end: offset + head.length } };
    head = head.slice(0, at);
  }

  let keyFilter: DescriptorPart | undefined;
  const dot = head.indexOf('.');
  if (dot >= 0) {
    keyFilter = { name: head.slice(dot + 1), range: { start: offset + dot + 1, end: offset + head.length } };
    head = head.slice(0, dot);
  }

  // Emitted even when empty. `->cart#add` with the caret at the start is the
  // event position waiting to be typed, which is exactly where completion is
  // wanted; a descriptor with no event at all returned above.
  const event = { name: head, range: { start: offset, end: offset + head.length } };

  return {
    event,
    ...(keyFilter ? { keyFilter } : {}),
    ...(eventTarget ? { eventTarget } : {}),
    options,
  };
}
