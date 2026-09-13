import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';
import * as oniguruma from 'vscode-oniguruma';
import * as textmate from 'vscode-textmate';

/**
 * Tokenizes the Twig grammar with the same engine VS Code uses, so highlighting
 * is verified rather than eyeballed. A grammar is easy to get subtly wrong in
 * ways a screenshot will not reveal, and this runs in CI with no editor.
 *
 * `text.html.basic` lives inside VS Code and is not available here, so it is
 * stubbed. That is the right boundary anyway: these tests cover the Twig
 * patterns, which are the part this repository owns.
 */

const SYNTAX_DIR = path.resolve(__dirname, '../syntaxes');

const HTML_STUB: textmate.IRawGrammar = {
  scopeName: 'text.html.basic',
  patterns: [
    // Just enough to prove Twig is matched before HTML claims the text, and to
    // show that surrounding markup is handed to the HTML grammar.
    { match: '</?[a-zA-Z][a-zA-Z0-9-]*', name: 'entity.name.tag.html' },
  ],
} as unknown as textmate.IRawGrammar;

let registry: textmate.Registry;
let grammar: textmate.IGrammar;

beforeAll(async () => {
  const wasm = await readFile(
    path.resolve(__dirname, '../../../node_modules/vscode-oniguruma/release/onig.wasm'),
  );
  await oniguruma.loadWASM(wasm);

  const twigSource = JSON.parse(
    await readFile(path.join(SYNTAX_DIR, 'twig.tmLanguage.json'), 'utf8'),
  ) as textmate.IRawGrammar;

  registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
      createOnigString: (value) => new oniguruma.OnigString(value),
    }),
    loadGrammar: (scopeName) => {
      if (scopeName === 'text.html.twig') {
        return Promise.resolve(twigSource);
      }
      if (scopeName === 'text.html.basic') {
        return Promise.resolve(HTML_STUB);
      }
      return Promise.resolve(null);
    },
  });

  const loaded = await registry.loadGrammar('text.html.twig');
  expect(loaded).not.toBeNull();
  grammar = loaded as textmate.IGrammar;
});

interface Token {
  readonly text: string;
  readonly scopes: readonly string[];
}

/** Tokenizes one line and returns each token with its scope stack. */
function tokenize(line: string): readonly Token[] {
  const result = grammar.tokenizeLine(line, textmate.INITIAL);
  return result.tokens.map((token) => ({
    text: line.slice(token.startIndex, token.endIndex),
    scopes: token.scopes,
  }));
}

/**
 * The scope stack of the token covering a snippet's first character.
 *
 * Located by index rather than by comparing token text: a token may be a
 * fragment of the snippet or extend past it, and matching on text picks the
 * wrong one.
 */
function scopesOf(line: string, snippet: string): readonly string[] {
  const at = line.indexOf(snippet);
  expect(at, `line should contain ${snippet}`).toBeGreaterThanOrEqual(0);

  const result = grammar.tokenizeLine(line, textmate.INITIAL);
  const token = result.tokens.find(
    (candidate) => candidate.startIndex <= at && at < candidate.endIndex,
  );
  expect(token, `expected a token covering ${snippet} at ${at}`).toBeDefined();
  return (token as textmate.IToken).scopes;
}

function hasScope(scopes: readonly string[], needle: string): boolean {
  return scopes.some((scope) => scope.startsWith(needle));
}

describe('statements', () => {
  it('marks the delimiters and the tag name', () => {
    const tokens = tokenize("{% extends 'base.html.twig' %}");
    expect(hasScope(tokens[0]!.scopes, 'punctuation.definition.tag.begin.twig')).toBe(true);
    expect(hasScope(scopesOf("{% extends 'x' %}", 'extends'), 'keyword.control.twig')).toBe(true);
  });

  it('marks a template name as a string', () => {
    const scopes = scopesOf("{% extends 'base.html.twig' %}", 'base.html.twig');
    expect(hasScope(scopes, 'string.quoted.single.twig')).toBe(true);
  });

  it('handles whitespace control modifiers', () => {
    const tokens = tokenize("{%- extends 'base.html.twig' -%}");
    expect(hasScope(tokens[0]!.scopes, 'punctuation.definition.tag.begin.twig')).toBe(true);
    expect(hasScope(scopesOf("{%- extends 'x' -%}", 'extends'), 'keyword.control.twig')).toBe(true);
  });

  it('marks block and endblock', () => {
    expect(hasScope(scopesOf('{% block body %}', 'block'), 'keyword.control.twig')).toBe(true);
    expect(hasScope(scopesOf('{% endblock %}', 'endblock'), 'keyword.control.twig')).toBe(true);
  });

  it('marks for and in', () => {
    const line = '{% for task in tasks %}';
    expect(hasScope(scopesOf(line, 'for'), 'keyword.control.twig')).toBe(true);
    expect(hasScope(scopesOf(line, 'in tasks'), 'keyword')).toBe(true);
  });
});

describe('expressions', () => {
  it('marks the output delimiters', () => {
    const tokens = tokenize('{{ openCount }}');
    expect(hasScope(tokens[0]!.scopes, 'punctuation.definition.tag.begin.twig')).toBe(true);
  });

  it('marks a bare variable', () => {
    expect(hasScope(scopesOf('{{ openCount }}', 'openCount'), 'variable.other.twig')).toBe(true);
  });

  it('distinguishes a property from a variable', () => {
    const scopes = scopesOf('{{ task.title }}', '.title');
    expect(hasScope(scopes, 'variable.other.property.twig') || hasScope(scopes, 'punctuation.accessor.twig')).toBe(true);
  });

  it('marks a filter after a pipe', () => {
    expect(hasScope(scopesOf("{{ name|upper }}", '|upper'), 'keyword.operator.filter.twig')).toBe(
      true,
    );
  });

  it('marks a function call', () => {
    expect(hasScope(scopesOf("{{ path('task_index') }}", 'path'), 'support.function.twig')).toBe(
      true,
    );
  });

  it('marks numbers and language constants', () => {
    expect(hasScope(scopesOf('{{ 42 }}', '42'), 'constant.numeric.twig')).toBe(true);
    expect(hasScope(scopesOf('{{ true }}', 'true'), 'constant.language.twig')).toBe(true);
  });

  it('marks a ternary operator', () => {
    expect(hasScope(scopesOf("{{ a ? 'y' : 'n' }}", '?'), 'keyword.operator.twig')).toBe(true);
  });
});

describe('comments', () => {
  it('marks the whole comment', () => {
    const scopes = scopesOf('{# a note #}', 'a note');
    expect(hasScope(scopes, 'comment.block.twig')).toBe(true);
  });

  it('does not highlight Twig inside a comment', () => {
    const scopes = scopesOf("{# {% extends 'x' %} #}", 'extends');
    expect(hasScope(scopes, 'comment.block.twig')).toBe(true);
    expect(hasScope(scopes, 'keyword.control.twig')).toBe(false);
  });
});

describe('HTML alongside Twig', () => {
  it('hands markup to the HTML grammar', () => {
    const scopes = scopesOf('<h1>Tasks</h1>', '<h1');
    expect(hasScope(scopes, 'entity.name.tag.html')).toBe(true);
  });

  it('keeps Twig highlighted when it sits inside markup', () => {
    const line = '<h1>{{ title }}</h1>';
    expect(hasScope(scopesOf(line, 'title'), 'variable.other.twig')).toBe(true);
    expect(hasScope(scopesOf(line, '<h1'), 'entity.name.tag.html')).toBe(true);
  });
});

describe('verbatim', () => {
  it('does not treat its contents as Twig', () => {
    const lines = ['{% verbatim %}', "{{ notATwigVariable }}", '{% endverbatim %}'];
    let state = textmate.INITIAL;
    const perLine: Token[][] = [];
    for (const line of lines) {
      const result = grammar.tokenizeLine(line, state);
      state = result.ruleStack;
      perLine.push(
        result.tokens.map((token) => ({
          text: line.slice(token.startIndex, token.endIndex),
          scopes: token.scopes,
        })),
      );
    }

    const inside = perLine[1] ?? [];
    const variableToken = inside.find((token) => token.text.includes('notATwigVariable'));
    expect(variableToken).toBeDefined();
    expect(hasScope((variableToken as Token).scopes, 'variable.other.twig')).toBe(false);
  });
});
