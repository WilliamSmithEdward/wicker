import { describe, expect, it } from 'vitest';

import { significantTokens, tokenizePhp, type PhpToken } from './lexer.js';

function kinds(source: string): string[] {
  return significantTokens(source).map((token) => token.kind);
}

function texts(source: string): string[] {
  return significantTokens(source).map((token) => token.text);
}

function strings(source: string): PhpToken[] {
  return tokenizePhp(source).filter((token) => token.kind === 'string');
}

/** Asserts the invariant every caller depends on: offsets select the value. */
function expectOffsetsSelectContents(source: string, token: PhpToken): void {
  expect(source.slice(token.contentStart, token.contentEnd)).toBeDefined();
  expect(token.start).toBeLessThan(token.end);
}

describe('tags and inline HTML', () => {
  it('separates inline HTML from PHP', () => {
    const tokens = tokenizePhp('<p>hi</p><?php $a; ?><p>bye</p>');
    expect(tokens[0]?.kind).toBe('inline-html');
    expect(tokens[0]?.text).toBe('<p>hi</p>');
    expect(tokens.at(-1)?.kind).toBe('inline-html');
    expect(tokens.at(-1)?.text).toBe('<p>bye</p>');
  });

  it('reads a file with no closing tag', () => {
    expect(kinds('<?php $a;')).toEqual(['open-tag', 'variable', 'punctuation']);
  });

  it('reads the short echo tag', () => {
    expect(tokenizePhp('<?= $a ?>')[0]?.text).toBe('<?=');
  });

  it('treats a file with no PHP as one run of inline HTML', () => {
    expect(tokenizePhp('just text').map((t) => t.kind)).toEqual(['inline-html']);
    // Inline HTML is trivia, so the significant stream is empty.
    expect(kinds('just text')).toEqual([]);
  });
});

describe('comments', () => {
  it.each([
    ['// a note\n$a;', '// a note'],
    ['# a note\n$a;', '# a note'],
    ['/* a note */ $a;', '/* a note */'],
    ['/** a doc */ $a;', '/** a doc */'],
  ])('reads %s', (body, expected) => {
    const comment = tokenizePhp(`<?php ${body}`).find((token) => token.kind === 'comment');
    expect(comment?.text).toBe(expected);
  });

  it('ends a line comment at a closing tag, which closes PHP from inside one', () => {
    const tokens = tokenizePhp('<?php // note ?> after');
    expect(tokens.find((t) => t.kind === 'comment')?.text).toBe('// note ');
    expect(tokens.at(-1)?.kind).toBe('inline-html');
  });

  it('reads an unterminated block comment to the end', () => {
    expect(tokenizePhp('<?php /* forever').find((t) => t.kind === 'comment')?.text).toBe(
      '/* forever',
    );
  });

  it('drops comments from the significant stream', () => {
    expect(kinds('<?php /* x */ $a; // y')).toEqual(['open-tag', 'variable', 'punctuation']);
  });
});

describe('attributes versus comments', () => {
  it('reads #[ as an attribute, not a comment', () => {
    // This is the distinction that decides whether every #[Route] and
    // #[Template] in a project is visible or invisible.
    const tokens = significantTokens("<?php #[Route('/')] function a() {}");
    expect(tokens[1]?.kind).toBe('attribute-open');
    expect(tokens[2]?.text).toBe('Route');
  });

  it('still reads a lone # as a comment', () => {
    expect(tokenizePhp('<?php # not an attribute\n$a;').some((t) => t.kind === 'comment')).toBe(
      true,
    );
  });
});

describe('strings', () => {
  it('reads a single-quoted string and its value', () => {
    const [token] = strings("<?php 'home/index.html.twig';");
    expect(token?.value).toBe('home/index.html.twig');
  });

  it('reports offsets that select the contents, inside the quotes', () => {
    const source = "<?php $a = 'home/index.html.twig';";
    const [token] = strings(source);
    expect(token).toBeDefined();
    expect(source.slice(token?.contentStart, token?.contentEnd)).toBe('home/index.html.twig');
  });

  it('applies single-quote escaping, where only \\\\ and \\\' are escapes', () => {
    expect(strings("<?php 'it\\'s';")[0]?.value).toBe("it's");
    expect(strings("<?php 'C:\\\\path';")[0]?.value).toBe('C:\\path');
    // A backslash before anything else stays literal, unlike double quotes.
    expect(strings("<?php 'a\\nb';")[0]?.value).toBe('a\\nb');
  });

  it('reads a double-quoted string and decodes its escapes', () => {
    expect(strings('<?php "a\\nb";')[0]?.value).toBe('a\nb');
    expect(strings('<?php "say \\"hi\\"";')[0]?.value).toBe('say "hi"');
  });

  it('marks an interpolated string, whose value is not statically known', () => {
    const tokens = tokenizePhp('<?php "home/$page.html.twig";');
    expect(tokens.some((t) => t.kind === 'interpolated-string')).toBe(true);
    expect(tokens.some((t) => t.kind === 'string')).toBe(false);
  });

  it('marks brace interpolation too', () => {
    expect(tokenizePhp('<?php "home/{$page}.twig";').some((t) => t.kind === 'interpolated-string')).toBe(
      true,
    );
  });

  it('leaves a dollar that is not interpolation alone', () => {
    expect(strings('<?php "costs $ money";')[0]?.value).toBe('costs $ money');
  });

  it('reads an unterminated string to the end rather than failing', () => {
    const source = "<?php $a = 'unterminated";
    const [token] = strings(source);
    expect(token?.value).toBe('unterminated');
    expectOffsetsSelectContents(source, token as PhpToken);
  });
});

describe('heredoc and nowdoc', () => {
  it('reads a nowdoc as a literal string', () => {
    const source = "<?php $a = <<<'SQL'\nselect $x\nSQL;\n";
    const [token] = strings(source);
    expect(token?.value).toBe('select $x');
  });

  it('treats a heredoc containing a variable as interpolated', () => {
    const source = '<?php $a = <<<SQL\nselect $x\nSQL;\n';
    expect(tokenizePhp(source).some((t) => t.kind === 'interpolated-string')).toBe(true);
  });

  it('reads a heredoc with no interpolation as a plain string', () => {
    const source = '<?php $a = <<<HTML\nhome/index.html.twig\nHTML;\n';
    expect(strings(source)[0]?.value).toBe('home/index.html.twig');
  });

  it('strips the indentation of a closing label', () => {
    const source = "<?php $a = <<<'TXT'\n    indented\n    TXT;\n";
    expect(strings(source)[0]?.value).toBe('indented');
  });
});

describe('operators and names', () => {
  it('prefers the longest operator', () => {
    expect(texts('<?php $a ?-> b;')).toEqual(['<?php', '$a', '?->', 'b', ';']);
    expect(texts('<?php $a === $b;')).toEqual(['<?php', '$a', '===', '$b', ';']);
    expect(texts('<?php $a ?? $b;')).toEqual(['<?php', '$a', '??', '$b', ';']);
  });

  it('reads a qualified name as identifiers separated by backslashes', () => {
    expect(texts('<?php App\\Controller\\Home;')).toEqual([
      '<?php',
      'App',
      '\\',
      'Controller',
      '\\',
      'Home',
      ';',
    ]);
  });

  it('reads a variable with its sigil', () => {
    const token = significantTokens('<?php $controller;')[1];
    expect(token?.kind).toBe('variable');
    expect(token?.text).toBe('$controller');
  });

  it.each([['42'], ['0x1f'], ['0b1010'], ['1_000'], ['1.5']])(
    'reads %s as a single number token',
    (literal) => {
      const tokens = significantTokens(`<?php ${literal};`);
      expect(tokens[1]?.kind).toBe('number');
      expect(tokens[1]?.text).toBe(literal);
    },
  );
});

describe('a realistic controller', () => {
  const source = `<?php

namespace App\\Controller;

final class HomeController extends AbstractController
{
    #[Route('/', name: 'app_home')]
    public function index(): Response
    {
        return $this->render('home/index.html.twig', [
            'controller_name' => 'HomeController',
        ]);
    }
}
`;

  it('finds every string with usable offsets', () => {
    for (const token of strings(source)) {
      expect(source.slice(token.contentStart, token.contentEnd)).toBe(token.value);
    }
  });

  it('finds the template name', () => {
    expect(strings(source).map((t) => t.value)).toContain('home/index.html.twig');
  });

  it('reads the attribute as an attribute', () => {
    expect(tokenizePhp(source).some((t) => t.kind === 'attribute-open')).toBe(true);
  });

  it('produces no unknown tokens', () => {
    expect(tokenizePhp(source).filter((t) => t.kind === 'unknown')).toEqual([]);
  });
});
