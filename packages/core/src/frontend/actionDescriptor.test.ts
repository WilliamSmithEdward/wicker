import { describe, expect, it } from 'vitest';

import { parseActionDescriptor } from './actionDescriptor.js';

describe('parseActionDescriptor', () => {
  function parts(text: string): Record<string, unknown> {
    const parsed = parseActionDescriptor(text, 0);
    const slice = (part?: { name: string; range: { start: number; end: number } }): string | undefined => {
      if (!part) { return undefined; }
      // The range must point at the part it names, not merely carry the text.
      expect(text.slice(part.range.start, part.range.end)).toBe(part.name);
      return part.name;
    };
    return {
      event: slice(parsed.event), keyFilter: slice(parsed.keyFilter),
      eventTarget: slice(parsed.eventTarget), options: parsed.options.map((option) => slice(option)),
    };
  }

  it('splits a descriptor with every part present', () => {
    expect(parts('keydown.enter@window->search#submit:prevent')).toEqual({
      event: 'keydown', keyFilter: 'enter', eventTarget: 'window', options: ['prevent'],
    });
  });

  it('reads a plain event', () => {
    expect(parts('click->cart#add')).toEqual({
      event: 'click', keyFilter: undefined, eventTarget: undefined, options: [],
    });
  });

  it('reads several options', () => {
    expect(parts('click->cart#add:prevent:once')).toMatchObject({ options: ['prevent', 'once'] });
  });

  it('has no event when the descriptor relies on the element default', () => {
    // `<button data-action="cart#add">` binds click without naming it.
    expect(parts('cart#add')).toEqual({
      event: undefined, keyFilter: undefined, eventTarget: undefined, options: [],
    });
  });

  it('still finds options on a default-event descriptor', () => {
    expect(parts('cart#add:prevent')).toMatchObject({ event: undefined, options: ['prevent'] });
  });

  it('does not mistake a global target for a key filter', () => {
    expect(parts('scroll@window->nav#track')).toEqual({
      event: 'scroll', keyFilter: undefined, eventTarget: 'window', options: [],
    });
  });

  it('reads a partial descriptor mid-edit, with an empty name at the cursor', () => {
    // An empty name marks the editing position, which is what completion
    // needs and what the rest of the scanner already does.
    expect(parts('keydown.')).toMatchObject({ event: 'keydown', keyFilter: '' });
    expect(parts('keydown.->a#b')).toMatchObject({ event: 'keydown', keyFilter: '' });
    expect(parts('click@->a#b')).toMatchObject({ event: 'click', eventTarget: '' });
    expect(parts('click@')).toMatchObject({ event: 'click', eventTarget: '' });
    // The caret sitting before the arrow is the event position itself.
    expect(parts('->cart#add')).toMatchObject({ event: '' });
  });

  it('treats a bare controller name as a default-event descriptor, not an event', () => {
    // A controller identifier is lowercase, digits and dashes, so text with
    // no dot or at sign before the # is the controller half.
    expect(parts('user-card#open')).toEqual({
      event: undefined, keyFilter: undefined, eventTarget: undefined, options: [],
    });
  });
});
