import { describe, expect, it } from 'vitest';

import { commandLabel, describeTimings, slowestAnswer, type ConsoleTiming } from './consoleTimings.js';

describe('console timings', () => {
  const timings: readonly ConsoleTiming[] = [
    { command: ['debug:twig', '--format=json'], ms: 6234, ok: true },
    { command: ['debug:config', 'framework', 'asset_mapper', '--format=json', '--no-ansi'], ms: 812, ok: true },
    { command: ['debug:router', '--format=json', '--no-ansi'], ms: 60000, ok: false },
  ];

  it('names a command by its words, without its flags', () => {
    expect(timings.map((timing) => commandLabel(timing.command)))
      .toEqual(['debug:twig', 'debug:config framework asset_mapper', 'debug:router']);
  });

  it('lists every command slowest first and says which did not answer', () => {
    expect(describeTimings(timings))
      .toBe('debug:router failed after 60.0 s, debug:twig 6.2 s, debug:config framework asset_mapper 0.8 s');
  });

  it('says so when nothing has been asked', () => {
    expect(describeTimings([])).toBe('not asked');
  });

  it('takes the slowest from those that answered, leaving the list as it was', () => {
    expect(slowestAnswer(timings)?.command[0]).toBe('debug:twig');
    expect(timings[0]?.command[0]).toBe('debug:twig');
    expect(slowestAnswer([{ command: ['debug:twig'], ms: 10, ok: false }])).toBeUndefined();
  });
});
