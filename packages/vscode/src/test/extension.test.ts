import * as assert from 'node:assert/strict';
import * as path from 'node:path';

import * as vscode from 'vscode';

/**
 * These tests drive the real extension inside a real VS Code instance against
 * a fixture Symfony project. They call the same provider commands the editor
 * calls, so a passing run means the feature genuinely works rather than that
 * its internals were exercised.
 */

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures/symfony-app');

function fixtureUri(...segments: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(FIXTURE_ROOT, ...segments));
}

async function open(...segments: string[]): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(fixtureUri(...segments));
  await vscode.window.showTextDocument(document, { preview: false });
  return document;
}

/** Position of the first occurrence of `needle`, offset into it by `within`. */
function positionOf(document: vscode.TextDocument, needle: string, within = 1): vscode.Position {
  const index = document.getText().indexOf(needle);
  assert.notEqual(index, -1, `fixture should contain ${needle}`);
  return document.positionAt(index + within);
}

async function definitionsAt(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<(vscode.Location | vscode.LocationLink)[]> {
  return (
    (await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      'vscode.executeDefinitionProvider',
      document.uri,
      position,
    )) ?? []
  );
}

function targetPath(link: vscode.Location | vscode.LocationLink): string {
  const uri = 'targetUri' in link ? link.targetUri : link.uri;
  return path.relative(FIXTURE_ROOT, uri.fsPath).split(path.sep).join('/');
}

/** The single definition these tests expect, as a fixture-relative path. */
function onlyTargetPath(links: readonly (vscode.Location | vscode.LocationLink)[]): string {
  const first = links[0];
  assert.ok(first !== undefined, 'expected at least one definition');
  return targetPath(first);
}

/** Waits for a condition, since indexing and diagnostics are asynchronous. */
async function waitFor<T>(
  produce: () => T | undefined | Promise<T | undefined>,
  description: string,
  timeoutMs = 8000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await produce();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

suite('Wicker', () => {
  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('WilliamSmithE.wicker');
    assert.ok(extension, 'the extension should be present');
    await extension.activate();
  });

  test('the fixture workspace is open and readable', async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    console.log('FIXTURE_ROOT   :', FIXTURE_ROOT);
    console.log('workspaceFolders:', folders.map((f) => f.uri.toString()).join(' | ') || '(none)');

    assert.ok(folders.length > 0, 'a workspace folder should be open');

    const root = folders[0];
    assert.ok(root !== undefined);
    console.log('root.uri.path   :', root.uri.path);
    console.log('root.uri.fsPath :', root.uri.fsPath);

    // Prove the extension's own filesystem route can reach composer.json.
    const composer = vscode.Uri.joinPath(root.uri, 'composer.json');
    const bytes = await vscode.workspace.fs.readFile(composer);
    console.log('composer.json bytes:', bytes.length);
    assert.ok(bytes.length > 0, 'composer.json should be readable through workspace.fs');
  });

  suite('go to definition from PHP', () => {
    test('resolves a render() template to its file', async () => {
      const document = await open('src', 'Controller', 'TaskController.php');
      const links = await waitFor(async () => {
        const found = await definitionsAt(document, positionOf(document, 'task/index.html.twig'));
        return found.length > 0 ? found : undefined;
      }, 'the index to resolve task/index.html.twig');

      assert.equal(onlyTargetPath(links), 'templates/task/index.html.twig');
    });

    test('offers nothing for a template that does not exist', async () => {
      const document = await open('src', 'Controller', 'TaskController.php');
      const links = await definitionsAt(
        document,
        positionOf(document, 'task/does_not_exist.html.twig'),
      );
      assert.equal(links.length, 0);
    });

    test('offers nothing on an ordinary string', async () => {
      const document = await open('src', 'Controller', 'TaskController.php');
      const links = await definitionsAt(document, positionOf(document, 'App\\Controller'));
      assert.equal(links.length, 0);
    });
  });

  suite('go to definition from Twig', () => {
    test('resolves an extends target', async () => {
      const document = await open('templates', 'task', 'index.html.twig');
      const links = await definitionsAt(document, positionOf(document, 'base.html.twig'));
      assert.equal(onlyTargetPath(links), 'templates/base.html.twig');
    });

    test('resolves an include target', async () => {
      const document = await open('templates', 'task', 'index.html.twig');
      const links = await definitionsAt(document, positionOf(document, 'task/_row.html.twig'));
      assert.equal(onlyTargetPath(links), 'templates/task/_row.html.twig');
    });

    test('resolves a namespaced template from the include() function', async () => {
      const document = await open('templates', 'task', 'index.html.twig');
      const links = await definitionsAt(document, positionOf(document, '@Design/badge.html.twig'));
      assert.equal(onlyTargetPath(links), 'design/badge.html.twig');
    });
  });

  suite('hover', () => {
    test('names the resolved file and the context keys', async () => {
      const document = await open('src', 'Controller', 'TaskController.php');
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        positionOf(document, 'task/index.html.twig'),
      );

      const text = hovers
        .flatMap((hover) => hover.contents)
        .map((content) => (typeof content === 'string' ? content : content.value))
        .join('\n');

      assert.match(text, /templates\/task\/index\.html\.twig/);
      assert.match(text, /tasks/);
      assert.match(text, /openCount/);
    });
  });

  suite('completion', () => {
    test('offers indexed template names inside the quotes', async () => {
      const document = await open('src', 'Controller', 'TaskController.php');
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        positionOf(document, 'task/index.html.twig'),
      );

      const labels = list.items.map((item) =>
        typeof item.label === 'string' ? item.label : item.label.label,
      );
      assert.ok(labels.includes('base.html.twig'), 'should offer base.html.twig');
      assert.ok(labels.includes('task/_row.html.twig'), 'should offer the row partial');
      assert.ok(labels.includes('@Design/badge.html.twig'), 'should offer namespaced templates');
    });
  });

  suite('diagnostics', () => {
    test('reports a missing template in PHP', async () => {
      const document = await open('src', 'Controller', 'TaskController.php');
      const found = await waitFor(
        () => {
          const all = vscode.languages.getDiagnostics(document.uri);
          return all.find((d) => d.message.includes('does_not_exist'));
        },
        'a diagnostic for the missing template',
      );
      assert.equal(found.severity, vscode.DiagnosticSeverity.Error);
      assert.equal(found.source, 'wicker');
    });

    test('explains an unregistered namespace rather than just saying not found', async () => {
      const document = await open('src', 'Controller', 'TaskController.php');
      const found = await waitFor(
        () =>
          vscode.languages
            .getDiagnostics(document.uri)
            .find((d) => d.message.includes('@Nope')),
        'a diagnostic for the unknown namespace',
      );
      assert.match(found.message, /namespace/i);
    });

    test('reports a missing include from Twig', async () => {
      const document = await open('templates', 'task', 'index.html.twig');
      const found = await waitFor(
        () =>
          vscode.languages
            .getDiagnostics(document.uri)
            .find((d) => d.message.includes('_gone.html.twig')),
        'a diagnostic for the missing include',
      );
      assert.equal(found.source, 'wicker');
    });

    test('does not report templates that exist', async () => {
      const document = await open('templates', 'task', 'index.html.twig');
      // Give diagnostics a moment, then assert the good references are clean.
      await waitFor(
        () =>
          vscode.languages
            .getDiagnostics(document.uri)
            .find((d) => d.message.includes('_gone.html.twig')),
        'diagnostics to settle',
      );
      const messages = vscode.languages.getDiagnostics(document.uri).map((d) => d.message);
      assert.ok(!messages.some((m) => m.includes('base.html.twig')));
      assert.ok(!messages.some((m) => m.includes('_row.html.twig')));
      assert.ok(!messages.some((m) => m.includes('badge.html.twig')));
    });
  });
});
