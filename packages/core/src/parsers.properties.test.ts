/**
 * Properties of the readers that take text Wicker does not control: a
 * project's PHP and Twig, its YAML and JSON configuration, and what the
 * Symfony console prints. They run on generated input from fast-check, a
 * hundred cases each by default and many more in the daily Fuzz workflow,
 * which sets WICKER_PROPERTY_RUNS. A failure prints the smallest input that
 * breaks the property; it becomes an example in the reader's own tests.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseJsonLoosely } from './console/consoleRunner.js';
import { parseActionDescriptor } from './frontend/actionDescriptor.js';
import { parseImportMap } from './frontend/importMap.js';
import { tokenizePhp } from './php/lexer.js';
import { parseComposerManifest } from './project/composer.js';
import { parseTwigConfig } from './project/twigConfig.js';
import { tokenizeTwigExpression } from './twig/expressionLexer.js';
import { parseTemplateName } from './twig/templateName.js';
import { lexTwigRegions, readStringLiterals } from './twig/twigLexer.js';
import { scanTwigTemplateReferences } from './twig/twigReferences.js';
import { parseYaml } from './util/yaml.js';

const runs = Number(process.env.WICKER_PROPERTY_RUNS ?? '100');
const settings = { numRuns: runs };

// Source built from the characters these grammars turn on, so generated text
// reaches deep into each reader rather than staying in plain text.
const fragments = [
  '<?php', '?>', '<?=', '{{', '}}', '{%', '%}', '{#', '#}', '-', '~', '\'', '"', '\\', '#{', '}',
  '(', ')', '[', ']', '{', ':', ',', ';', '|', '.', '..', '?', '=>', '->', '::', '$', '@', '//',
  '/*', '*/', '#', '<<<', 'EOT', '\n', '\r\n', '  ', '\t', 'render', 'include', 'extends', '"a"',
  "'b.html.twig'", '@App/x', '- ', 'key:', ' value', '|', '>', '&', '*', '!', '0', '1.5', 'é', '\u0000',
];
const source = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 300 }),
  fc.array(fc.constantFrom(...fragments), { maxLength: 80 }).map((parts) => parts.join('')),
);

describe('PHP lexer', () => {
  // Whitespace inside PHP is not a token, so the stream may skip it, and only it.
  it('never throws, and its tokens run in order and skip nothing but whitespace', () => {
    fc.assert(
      fc.property(source, (text) => {
        let cursor = 0;
        for (const token of tokenizePhp(text)) {
          expect(token.start).toBeGreaterThanOrEqual(cursor);
          expect(text.slice(cursor, token.start).trim()).toBe('');
          expect(token.end).toBeGreaterThan(token.start);
          expect(token.text).toBe(text.slice(token.start, token.end));
          cursor = token.end;
        }
        expect(text.slice(cursor).trim()).toBe('');
      }),
      settings,
    );
  });
});

describe('Twig lexer', () => {
  it('splits the source into regions that cover it exactly', () => {
    fc.assert(
      fc.property(source, (text) => {
        let cursor = 0;
        for (const region of lexTwigRegions(text)) {
          expect(region.start).toBe(cursor);
          expect(region.end).toBeGreaterThan(region.start);
          expect(region.innerStart).toBeGreaterThanOrEqual(region.start);
          expect(region.innerEnd).toBeGreaterThanOrEqual(region.innerStart);
          expect(region.innerEnd).toBeLessThanOrEqual(region.end);
          cursor = region.end;
        }
        expect(cursor).toBe(text.length);
      }),
      settings,
    );
  });

  it('lexes an expression and reads string literals inside the range it is given', () => {
    fc.assert(
      fc.property(source, fc.nat(), fc.nat(), (text, a, b) => {
        const from = text.length === 0 ? 0 : a % (text.length + 1);
        const to = from + (text.length === 0 ? 0 : b % (text.length - from + 1));
        for (const token of tokenizeTwigExpression(text, from, to)) {
          expect(token.start).toBeGreaterThanOrEqual(from);
          expect(token.end).toBeLessThanOrEqual(to);
        }
        for (const literal of readStringLiterals(text, from, to)) {
          expect(literal.start).toBeGreaterThanOrEqual(from);
          expect(literal.end).toBeLessThanOrEqual(to);
        }
      }),
      settings,
    );
  });

  it('scans template references and names without throwing', () => {
    fc.assert(
      fc.property(source, (text) => {
        for (const reference of scanTwigTemplateReferences(text)) {
          expect(reference.range.start).toBeGreaterThanOrEqual(0);
          expect(reference.range.end).toBeLessThanOrEqual(text.length);
          expect(reference.nameRange.start).toBeGreaterThanOrEqual(reference.range.start);
          expect(reference.nameRange.end).toBeLessThanOrEqual(reference.range.end);
        }
        parseTemplateName(text);
      }),
      settings,
    );
  });
});

describe('configuration and console output', () => {
  it('reads YAML, JSON, composer.json, twig.yaml and import maps without throwing', () => {
    fc.assert(
      fc.property(fc.oneof(source, fc.json()), (text) => {
        parseYaml(text);
        parseJsonLoosely(text);
        parseComposerManifest(text);
        parseTwigConfig(text);
        parseImportMap(text);
      }),
      settings,
    );
  });

  it('reads a Stimulus action descriptor at any offset without throwing', () => {
    fc.assert(
      fc.property(source, fc.nat(), (text, offset) => {
        parseActionDescriptor(text, text.length === 0 ? 0 : offset % (text.length + 1));
      }),
      settings,
    );
  });
});
