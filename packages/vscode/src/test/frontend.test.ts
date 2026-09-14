import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LoaderPathMemory } from '../loaderPathMemory.js';
import { SessionManager } from '../session.js';
import { ProjectTreeProvider } from '../sidebar.js';

const ROOT = path.resolve(__dirname, '../../fixtures/symfony-app');
const JS = 'assets/controllers/wicker_test_controller.js';
const PEER = 'assets/controllers/wicker_peer_controller.ts';
const PHP = 'src/Controller/WickerFrontendTestController.php';
const TWIG = 'templates/wicker_frontend_test.html.twig';
const routes = {
  wicker_test_fragment: { path: '/_wicker-test/fragment', method: 'GET', defaults: { _controller: 'App\\Controller\\WickerFrontendTestController::fragment' } },
  wicker_test_json: { path: '/_wicker-test/api', method: 'GET', defaults: { _controller: 'App\\Controller\\WickerFrontendTestController::data' } },
  wicker_test_first: { path: '/_wicker-test/zebra', method: 'GET', defaults: { _controller: 'App\\Controller\\WickerFrontendTestController::aaa' } },
  wicker_test_last: { path: '/_wicker-test/alpha', method: 'GET', defaults: { _controller: 'App\\Controller\\WickerFrontendTestController::zzz' } },
};
const CONSOLE = `const args = process.argv; const root = process.cwd();
const routes = ${JSON.stringify(routes)};
try { if (!require('node:fs').readFileSync('${PHP}', 'utf8').includes("name: 'wicker_test_json'")) delete routes.wicker_test_json; } catch {}
process.stdout.write(JSON.stringify(args.includes('debug:router') ? routes :
args.includes('asset_mapper') ? {paths:{'assets/':''},excluded_patterns:['*.d.ts'],exclude_dotfiles:true,public_prefix:'/assets/'} :
args.includes('debug:config') ? {stimulus:{controller_paths:[root + '/assets/controllers'],controllers_json:root + '/assets/controllers.json'}} :
args.includes('debug:container') ? {'kernel.project_dir':root} :
{loader_paths:{'(None)':['templates']}, functions:{path:[], stimulus_controller:[], stimulus_action:[], stimulus_target:[]}, filters:{}}));`;
const phpSource = `<?php namespace App\\Controller;
class WickerFrontendTestController {
  #[Route('/_wicker-test/api', name: 'wicker_test_json', methods: ['GET'])]
  public function data() { return $this->json(['message' => 'Ready', 'meta' => ['count' => 2]]); }
  #[Route('/_wicker-test/fragment', name: 'wicker_test_fragment', methods: ['GET'])]
  public function fragment() { return $this->render('wicker_frontend_test.html.twig'); }
  public function aaa() { return $this->render('wicker_frontend_test.html.twig'); }
  public function zzz() { return $this->render('wicker_frontend_test.html.twig'); }
}`;
const jsSource = `import { Controller } from '@hotwired/stimulus';
export default class extends Controller {
  static targets = ['output'];
  static values = { url: String, itemCount: Number };
  async refresh() { const response = await fetch(this.urlValue); const data = await response.json(); this.outputTarget.textContent = data.message; }
}`;
const pageSource = `<div {{ stimulus_controller('wicker-test', {url: path('wicker_test_json')}) }}>
  <button {{ stimulus_action('wicker-test', 'refresh', 'click') }}>Refresh</button>
  <output data-wicker-test-target="output"></output>
</div>
<script>async function fragment() { const response = await fetch('/_wicker-test/fragment'); return response.text(); }</script>`;
const peerSource = `export default class { increment(): void {} reset(): void {} }`;
const outletSource = jsSource.replace('static targets', "static outlets = ['wicker-peer'];\n  static targets");
const outletPage = `<div {{ stimulus_controller('wicker-test', controllerOutlets: {'wicker-peer': '#peer'}) }}></div>
<output id="peer" {{ stimulus_controller('wicker-peer') }}></output>`;
const uri = (file: string): vscode.Uri => vscode.Uri.file(path.join(ROOT, file));
async function replace(doc: vscode.TextDocument, source: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), source);
  assert.ok(await vscode.workspace.applyEdit(edit));
}
async function at(doc: vscode.TextDocument, marked: string): Promise<vscode.Position> {
  const offset = marked.indexOf('§'); assert.ok(offset >= 0);
  await replace(doc, marked.replace('§', '')); return doc.positionAt(offset);
}
async function items(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[]> {
  return (await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, pos))?.items ?? [];
}
async function definitions(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.LocationLink[]> {
  return (await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, pos))?.filter((link): link is vscode.LocationLink => 'targetUri' in link) ?? [];
}
async function eventually(check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'Frontend discovery should follow file changes');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

suite('Stimulus and API connections', () => {
  const settings = vscode.workspace.getConfiguration('wicker');
  let previousCommand: string[] | undefined, previousConsole: boolean | undefined;
  let page: vscode.TextDocument, js: vscode.TextDocument, php: vscode.TextDocument, peer: vscode.TextDocument;
  suiteSetup(async () => {
    await vscode.extensions.getExtension('WilliamSmithE.wicker')!.activate();
    previousCommand = settings.inspect<string[]>('console.command')?.workspaceValue;
    previousConsole = settings.inspect<boolean>('console.enabled')?.workspaceValue;
    for (const [file, source] of [[TWIG, pageSource], [JS, jsSource], [PHP, phpSource], [PEER, peerSource]]) {
      await vscode.workspace.fs.writeFile(uri(file!), Buffer.from(source!));
    }
    await settings.update('console.command', [process.env['npm_node_execpath'] ?? 'node', '-e', CONSOLE, '--'], vscode.ConfigurationTarget.Workspace);
    await settings.update('console.enabled', true, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('wicker.reindex');
    page = await vscode.workspace.openTextDocument(uri(TWIG));
    js = await vscode.workspace.openTextDocument(uri(JS));
    php = await vscode.workspace.openTextDocument(uri(PHP));
    peer = await vscode.workspace.openTextDocument(uri(PEER));
  });
  teardown(async () => { await replace(page, pageSource); await replace(js, jsSource); await replace(php, phpSource); await replace(peer, peerSource); });
  suiteTeardown(async () => {
    for (const doc of [page, js, php, peer]) {
      if (!doc) { continue; }
      await vscode.window.showTextDocument(doc); await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await vscode.workspace.fs.delete(doc.uri);
    }
    await settings.update('console.command', previousCommand, vscode.ConfigurationTarget.Workspace);
    await settings.update('console.enabled', previousConsole, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('wicker.reindex');
  });

  test('controller, action, target and value completion replace the exact reference', async () => {
    for (const [marked, expected] of [
      [`<div data-controller="wick§er-test">`, 'wicker-test'],
      [`{{ stimulus_action('wicker-test', 'ref§resh') }}`, 'refresh'],
      [`<output data-wicker-test-target="out§put">`, 'output'],
      [`{{ stimulus_controller('wicker-test', {itemCo§unt: 2}) }}`, 'itemCount'],
    ]) {
      const position = await at(page, marked!);
      const result = (await items(page, position)).find((item) => item.label === expected && item.detail?.startsWith('Stimulus'));
      assert.ok(result, `${expected} should complete`);
      const range = result.range instanceof vscode.Range ? result.range : result.range!.replacing;
      assert.equal(page.getText(range), expected);
    }
  });
  test('action, target and value definitions select declarations in the JS file', async () => {
    for (const [marked, expected] of [
      [`<button data-action="click->wicker-test#ref§resh:prevent">`, 'refresh'],
      [`{{ stimulus_target('wicker-test', 'out§put') }}`, 'output'],
      [`<div data-wicker-test-item-cou§nt-value="2">`, 'itemCount'],
    ]) {
      const links = await definitions(page, await at(page, marked!));
      const link = links.find((entry) => entry.targetUri.toString() === js.uri.toString());
      assert.ok(link, `${expected} should navigate`);
      assert.equal(js.getText(link.targetSelectionRange), expected);
    }
  });
  test('unsaved action renames change suggestions immediately', async () => {
    await replace(js, jsSource.replace('async refresh()', 'async reload()'));
    const result = await items(page, await at(page, `{{ stimulus_action('wicker-test', '§') }}`));
    assert.ok(result.some((item) => item.label === 'reload' && item.detail?.startsWith('Stimulus')));
    assert.ok(!result.some((item) => item.label === 'refresh' && item.detail?.startsWith('Stimulus')));
  });
  test('outlet names complete in named, positional, filtered and raw Twig bindings', async () => {
    await replace(js, outletSource);
    for (const marked of [
      `{{ stimulus_controller('wicker-test', controllerOutlets: {'wicker-p§eer': '#peer'}) }}`,
      `{{ stimulus_controller('wicker-test', {}, {}, {'wicker-p§eer': '#peer'}) }}`,
      `{{ stimulus_controller('other')|stimulus_controller('wicker-test', controllerOutlets: {'wicker-p§eer': '#peer'}) }}`,
      `<div data-wicker-test-wicker-p§eer-outlet="#peer">`,
    ]) {
      const position = await at(page, marked);
      const completion = (await items(page, position)).find((item) => item.label === 'wicker-peer' && item.detail?.startsWith('Stimulus outlet'));
      assert.ok(completion);
      const range = completion.range instanceof vscode.Range ? completion.range : completion.range!.replacing;
      assert.equal(page.getText(range), 'wicker-peer');
      const links = await definitions(page, position);
      assert.ok(links.some((link) => link.targetUri.toString() === js.uri.toString() && js.getText(link.targetSelectionRange) === 'wicker-peer'));
      assert.ok(links.some((link) => link.targetUri.toString() === peer.uri.toString()));
    }
  });
  test('outlet declarations complete registered controllers and navigate to TypeScript', async () => {
    const position = await at(js, outletSource.replace("'wicker-peer'", "'wicker-p§eer'"));
    assert.ok((await items(js, position)).some((item) => item.label === 'wicker-peer' && item.detail?.startsWith('Stimulus outlet')));
    assert.ok((await definitions(js, position)).some((link) => link.targetUri.toString() === peer.uri.toString()));
  });
  test('generated outlet properties coexist with ordinary JS and TS completions', async () => {
    for (const doc of [js, peer]) {
      const position = await at(doc, `export default class { static outlets = ['wicker-peer']; refresh() {} run() { this.§ } }`);
      const completions = await items(doc, position);
      assert.ok(completions.some((item) => item.label === 'hasWickerPeerOutlet' && item.detail?.startsWith('Stimulus outlet')));
      assert.ok(completions.some((item) => item.label === 'wickerPeerOutletElements' && item.detail?.startsWith('Stimulus outlet')));
      assert.ok(completions.some((item) => item.label === 'refresh'), 'Built-in JS/TS member completion must still run');
    }
  });
  test('outlet property and callback navigation returns the declaration, and methods reach the receiver', async () => {
    for (const suffix of ['run() { this.wickerPeerOut§let.increment(); }', 'wickerPeerOutletConn§ected(outlet, element) {}']) {
      const position = await at(js, outletSource.replace('async refresh()', `${suffix}\n  async refresh()`));
      const link = (await definitions(js, position)).find((link) => link.targetUri.toString() === js.uri.toString());
      assert.ok(link);
      assert.equal(js.getText(link.targetSelectionRange), 'wicker-peer');
    }
    const position = await at(js, outletSource.replace('async refresh()', 'run() { this.wickerPeerOutlet.incr§ement(); }\n async refresh()'));
    assert.ok((await items(js, position)).some((item) => item.label === 'increment' && item.detail?.startsWith('Stimulus outlet method')));
    const link = (await definitions(js, position)).find((link) => link.targetUri.toString() === peer.uri.toString());
    assert.ok(link);
    assert.equal(peer.getText(link.targetSelectionRange), 'increment');
    await replace(peer, peerSource.replace('increment', 'increase'));
    const completions = await items(js, position);
    assert.ok(completions.some((item) => item.label === 'increase' && item.detail?.startsWith('Stimulus outlet method')));
    assert.ok(!completions.some((item) => item.label === 'increment' && item.detail?.startsWith('Stimulus outlet method')));
  });
  test('selector hover explains page-wide controller matching and optional outlet access', async () => {
    await replace(js, outletSource);
    const position = await at(page, outletPage.replace('#peer', '#pe§er'));
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', page.uri, position);
    const text = hovers?.flatMap((hover) => hover.contents.map((content) => typeof content === 'string' ? content : content.value)).join('\n') ?? '';
    assert.ok(text.includes('anywhere on the page'), text);
    assert.ok(text.includes('hasWickerPeerOutlet'));
    assert.ok(text.includes('https://stimulus.hotwired.dev/reference/outlets'));
    assert.ok((await definitions(page, position)).some((link) => link.targetUri.toString() === peer.uri.toString()));
    assert.ok(!(await items(page, position)).some((item) => item.detail?.startsWith('Stimulus outlet')), 'Selector text must not be replaced by an outlet name');
  });
  test('outlet Find All References includes Twig bindings and generated accesses and follows unsaved changes', async () => {
    await replace(page, outletPage);
    const position = await at(js, outletSource.replace("'wicker-peer'", "'wicker-p§eer'").replace('async refresh()',
      'run() { if (this.hasWickerPeerOutlet) this.wickerPeerOutlet.increment(); }\n async refresh()'));
    const references = async (): Promise<vscode.Location[]> => await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', js.uri, position) ?? [];
    await eventually(async () => (await references()).some((ref) => ref.uri.toString() === page.uri.toString()));
    assert.ok((await references()).some((ref) => ref.uri.toString() === js.uri.toString() && js.getText(ref.range) === 'hasWickerPeerOutlet'));
    await replace(page, outletPage.replace("'wicker-peer':", "'other':"));
    await eventually(async () => !(await references()).some((ref) => ref.uri.toString() === page.uri.toString()));
  });
  test('turning off Wicker removes outlet completions, definitions, hovers and references', async () => {
    await replace(js, outletSource);
    const position = await at(page, outletPage.replace("'wicker-peer':", "'wicker-p§eer':"));
    const previous = settings.inspect<boolean>('enable')?.workspaceValue;
    try {
      await settings.update('enable', false, vscode.ConfigurationTarget.Workspace);
      await eventually(async () => !(await items(page, position)).some((item) => item.detail?.startsWith('Stimulus outlet')));
      assert.ok(!(await definitions(page, position)).some((link) => link.targetUri.toString() === peer.uri.toString()));
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', page.uri, position);
      assert.ok(!hovers?.some((hover) => hover.contents.some((content) => (typeof content === 'string' ? content : content.value).includes('hasWickerPeerOutlet'))));
      const refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', page.uri, position);
      assert.ok(!refs?.some((ref) => ref.uri.toString() === js.uri.toString()));
    } finally { await settings.update('enable', previous, vscode.ConfigurationTarget.Workspace); await vscode.commands.executeCommand('wicker.reindex'); }
  });
  test('outlet member navigation disappears when the receiving controller is deleted', async () => {
    const added = uri('assets/controllers/wicker_outlet_added_controller.ts');
    try {
      await vscode.workspace.fs.writeFile(added, Buffer.from('export default class { run(): void {} }'));
      const position = await at(js, `export default class { static outlets = ['wicker-outlet-added']; connect() { this.wickerOutletAddedOutlet.r§un(); } }`);
      await eventually(async () => (await definitions(js, position)).some((link) => link.targetUri.toString() === added.toString()));
      await vscode.workspace.fs.delete(added);
      await eventually(async () => !(await definitions(js, position)).some((link) => link.targetUri.toString() === added.toString()));
      assert.ok(!(await items(js, position)).some((item) => item.detail?.startsWith('Stimulus outlet method')));
    } finally { await deleteDependencyFiles([added]); }
  });
  test('outlet references never borrow a nested project binding', async () => {
    const nested = await vscode.workspace.openTextDocument(uri('nested-app/templates/task/_row.html.twig'));
    const original = nested.getText();
    try {
      await replace(page, '');
      await replace(nested, outletPage);
      const position = await at(js, outletSource.replace("'wicker-peer'", "'wicker-p§eer'"));
      const refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', js.uri, position);
      assert.ok(!refs?.some((ref) => ref.uri.toString() === nested.uri.toString()));
    } finally {
      await replace(nested, original);
      await vscode.window.showTextDocument(nested);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });
  test('route names and literal fetch URLs navigate to the correct PHP action', async () => {
    let links = await definitions(page, await at(page, `{{ path('wicker_test_js§on') }}`));
    assert.equal(php.getText(links.find((link) => link.targetUri.toString() === php.uri.toString())!.targetSelectionRange), 'data');
    links = await definitions(js, await at(js, `fetch('/_wicker-test/frag§ment')`));
    assert.equal(php.getText(links.find((link) => link.targetUri.toString() === php.uri.toString())!.targetSelectionRange), 'fragment');
    assert.ok(links.some((link) => link.targetUri.toString() === page.uri.toString()), 'Fetched HTML also links directly to its Twig template');
  });
  test('JSON fields complete and navigate from JS through Twig-bound Stimulus values', async () => {
    const position = await at(js, jsSource.replace('data.message', 'data.me§ssage'));
    const result = await items(js, position);
    assert.ok(result.some((item) => item.label === 'message' && item.detail?.startsWith('JSON response')));
    const links = await definitions(js, position);
    assert.equal(php.getText(links.find((link) => link.targetUri.toString() === php.uri.toString())!.targetSelectionRange), 'message');
    await replace(php, phpSource.replace("'message'", "'heading'"));
    const refreshed = await items(js, position);
    assert.ok(refreshed.some((item) => item.label === 'heading' && item.detail?.startsWith('JSON response')));
    assert.ok(!refreshed.some((item) => item.label === 'message' && item.detail?.startsWith('JSON response')));
  });
  test('inline JavaScript in Twig receives nested JSON fields without inventing Twig variables', async () => {
    const position = await at(page, `<script>async function run() { const response = await fetch("{{ path('wicker_test_json') }}"); const data = await response.json(); data.meta.co§unt; }</script>`);
    assert.ok((await items(page, position)).some((item) => item.label === 'count' && item.detail?.startsWith('JSON response')));
    const twigPosition = await at(page, '{{ data.me§ssage }}');
    assert.ok(!(await items(page, twigPosition)).some((item) => item.detail?.startsWith('JSON response')));
  });
  test('Find All References connects the PHP endpoint to Twig and JS consumers', async () => {
    const position = php.positionAt(php.getText().indexOf('function data') + 11);
    const refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', php.uri, position);
    assert.ok(refs?.some((ref) => ref.uri.toString() === page.uri.toString()));
    assert.ok(refs?.some((ref) => ref.uri.toString() === js.uri.toString()));
  });
  test('route sections show JSON and Twig endpoints with distinct identities and correct navigation', async () => {
    const memory = new Map<string, unknown>();
    const sessions = new SessionManager(new LoaderPathMemory({ keys: () => [...memory.keys()],
      get: <T>(key: string, fallback?: T): T | undefined => memory.get(key) as T | undefined ?? fallback,
      update: (key, value) => { memory.set(key, value); return Promise.resolve(); } }));
    await sessions.initialize();
    const tree = new ProjectTreeProvider(sessions);
    try {
      const root = tree.getChildren().find((node) => node.root.toString() === uri('').toString())!;
      const controllers = tree.getChildren(root).find((node) => node.kind === 'section' && node.section === 'controllers');
      assert.ok(controllers);
      const controller = tree.getChildren(controllers).find((node) => node.kind === 'controller' && node.className === 'App\\Controller\\WickerFrontendTestController');
      assert.ok(controller);
      const controllerActions = tree.getChildren(controller).filter((node) => node.kind === 'controllerMethod');
      // The JSON endpoint renders nothing, so it has no render site. It is
      // still an action of this controller, and listing its route under API
      // routes while omitting the action itself leaves the tree disagreeing
      // with itself about what the controller contains.
      assert.deepEqual(controllerActions.map((node) => tree.getTreeItem(node).label),
        ['GET /_wicker-test/alpha', 'GET /_wicker-test/api', 'GET /_wicker-test/fragment', 'GET /_wicker-test/zebra']);
      // And it carries the icon its route carries in the API section. A leaf
      // here would claim a template is rendered, which is the one thing this
      // action does not do.
      const jsonAction = controllerActions.find((node) => node.kind === 'controllerMethod' && node.methodName === 'data')!;
      assert.equal((tree.getTreeItem(jsonAction).iconPath as vscode.ThemeIcon).id, 'symbol-object');
      const action = controllerActions.find((node) => node.kind === 'controllerMethod' && node.methodName === 'fragment')!;
      const actionItem = tree.getTreeItem(action);
      assert.equal(actionItem.label, 'GET /_wicker-test/fragment');
      assert.equal(actionItem.description, 'fragment()');
      assert.ok(leafIconPath(actionItem).endsWith('/route-leaf-dark.svg'));
      assert.ok(typeof actionItem.tooltip === 'string');
      assert.ok(actionItem.tooltip.includes('wicker_test_fragment'));
      assert.ok(actionItem.tooltip.includes('wicker_frontend_test.html.twig'));
      const owningSession = sessions.sessionFor({ uri: uri('') })!;
      const discovered = owningSession.frontend;
      try {
        owningSession.frontend = { ...discovered, routes: [] };
        const fallback = tree.getTreeItem(action);
        assert.equal(fallback.id, actionItem.id);
        assert.equal(fallback.label, 'fragment()');
        assert.equal(fallback.description, 'wicker_frontend_test.html.twig');
      } finally { owningSession.frontend = discovered; }
      await vscode.commands.executeCommand(actionItem.command!.command, ...actionItem.command!.arguments!);
      assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), php.uri.toString());
      assert.equal(vscode.window.activeTextEditor?.document.getText(vscode.window.activeTextEditor.selection), 'wicker_frontend_test.html.twig');
      const section = tree.getChildren(root).find((node) => node.kind === 'section' && node.section === 'api'); assert.ok(section);
      const entries = tree.getChildren(section);
      assert.deepEqual(entries.map((node) => tree.getTreeItem(node).label), ['GET /_wicker-test/api', 'GET /_wicker-test/fragment']);
      assert.equal((tree.getTreeItem(entries[0]!).iconPath as vscode.ThemeIcon).id, 'symbol-object');
      assert.ok(leafIconPath(tree.getTreeItem(entries[1]!)).endsWith('/route-leaf-dark.svg'));
      const json = tree.getChildren(entries[0]);
      assert.ok(json.some((node) => node.kind === 'routeConsumer' && node.projectPath === JS));
      const html = tree.getChildren(entries[1]);
      assert.ok(html.some((node) => node.kind === 'routeTemplate' && node.templateName === TWIG.slice(10)));
      const templateSection = tree.getChildren(root).find((node) => node.kind === 'section' && node.section === 'templateRoutes');
      assert.ok(templateSection);
      assert.equal(tree.getTreeItem(templateSection).label, 'Template routes');
      const templateEntries = tree.getChildren(templateSection);
      assert.deepEqual(templateEntries.map((node) => tree.getTreeItem(node).label),
        ['GET /_wicker-test/alpha', 'GET /_wicker-test/fragment', 'GET /_wicker-test/zebra']);
      const templateRoute = templateEntries.find((node) => node.kind === 'route' && node.name === 'wicker_test_fragment')!;
      assert.ok(leafIconPath(tree.getTreeItem(templateRoute)).endsWith('/route-leaf-dark.svg'));
      assert.notEqual(tree.getTreeItem(templateRoute).id, tree.getTreeItem(entries[1]!).id);
      assert.deepEqual(tree.getParent(templateRoute), templateSection);
      const renderedTemplate = tree.getChildren(templateRoute).find((node) => node.kind === 'routeTemplate');
      assert.ok(renderedTemplate);
      assert.ok(leafIconPath(tree.getTreeItem(renderedTemplate)).endsWith('/template-leaf-dark.svg'));
      for (const treeItem of [tree.getTreeItem(renderedTemplate), tree.getTreeItem(templateRoute)]) {
        const icon = treeItem.iconPath as { light: vscode.Uri; dark: vscode.Uri };
        for (const file of [icon.light, icon.dark]) { assert.ok((await vscode.workspace.fs.readFile(file)).byteLength > 0); }
      }
      assert.deepEqual(tree.getParent(renderedTemplate), templateRoute);
      await vscode.commands.executeCommand('wicker.openEndpoint', renderedTemplate);
      assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), page.uri.toString());
      await vscode.commands.executeCommand('wicker.openEndpoint', entries[0]);
      assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), php.uri.toString());
      assert.equal(vscode.window.activeTextEditor?.document.getText(vscode.window.activeTextEditor.selection), 'data');
      await replace(php, phpSource.replaceAll("$this->render('wicker_frontend_test.html.twig')", "$this->json(['message' => 'changed'])"));
      assert.ok(!tree.getChildren(root).some((node) => node.kind === 'section' && node.section === 'templateRoutes'), 'Unsaved response changes update the route section');
    } finally { tree.dispose(); sessions.dispose(); }
  });
  test('wicker.enable disables the new surfaces', async () => {
    const previous = settings.inspect<boolean>('enable')?.workspaceValue;
    const position = await at(page, `{{ stimulus_action('wicker-test', 'ref§resh') }}`);
    try {
      await settings.update('enable', false, vscode.ConfigurationTarget.Workspace);
      assert.ok(!(await items(page, position)).some((item) => item.detail?.startsWith('Stimulus')));
      assert.equal((await definitions(page, position)).length, 0);
    } finally { await settings.update('enable', previous, vscode.ConfigurationTarget.Workspace); }
  });
  test('controller dependencies navigate to current project declarations and follow edits, deletion and disabling', async () => {
    const files = [
      ['src/Controller/WickerDependencyService.php', '<?php namespace App\\Service; class WickerDependencyService {}'],
      ['src/Controller/WickerDependencyRepository.php', '<?php namespace App\\Repository; class WickerDependencyRepository {}'],
      ['src/Controller/WickerDependencyEntity.php', '<?php namespace App\\Entity; class WickerDependencyEntity {}'],
      ['src/Controller/WickerDependencyContract.php', '<?php namespace App\\Contract; interface WickerDependencyContract {}'],
      ['src/Controller/WickerDependencyStatus.php', '<?php namespace App\\Model; enum WickerDependencyStatus { case Ready; }'],
      ['src/Controller/WickerDependencyOther.php', '<?php namespace App\\Model; class WickerDependencyOther {}'],
      // A nested project's declaration must not compete with the parent's type.
      ['nested-app/src/Controller/WickerDependencyService.php', '<?php namespace App\\Service; class WickerDependencyService {}'],
    ] as const;
    const injected = phpSource.replace('class WickerFrontendTestController {', `
use App\\Service\\WickerDependencyService as Worker;
use App\\Repository\\WickerDependencyRepository as Records;
use App\\Entity\\WickerDependencyEntity;
use App\\Contract\\WickerDependencyContract;
use App\\Model\\{WickerDependencyStatus, WickerDependencyOther};
class WickerFrontendTestController {
  public function __construct(private readonly Worker $worker, private Records $records) {}
  public WickerDependencyContract $contract;
  public function related(WickerDependencyEntity $entity, Worker $alsoWorker,
    WickerDependencyStatus $status, WickerDependencyOther $other) {}
`);
    const memory = new Map<string, unknown>();
    const sessions = new SessionManager(new LoaderPathMemory({ keys: () => [...memory.keys()],
      get: <T>(key: string, fallback?: T): T | undefined => memory.get(key) as T | undefined ?? fallback,
      update: (key, value) => { memory.set(key, value); return Promise.resolve(); } }));
    const tree = new ProjectTreeProvider(sessions);
    let target: vscode.TextDocument | undefined;
    const previous = settings.inspect<boolean>('enable')?.workspaceValue;
    try {
      for (const [file, source] of files) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri(file), '..'));
        await vscode.workspace.fs.writeFile(uri(file), Buffer.from(source));
      }
      await replace(php, injected);
      await vscode.commands.executeCommand('wicker.reindex');
      await sessions.initialize();
      const root = tree.getChildren().find((node) => node.root.toString() === uri('').toString())!;
      const controllers = tree.getChildren(root).find((node) => node.kind === 'section' && node.section === 'controllers')!;
      const controller = tree.getChildren(controllers).find((node) => node.kind === 'controller' && node.className.endsWith('WickerFrontendTestController'))!;
      const group = tree.getChildren(controller).find((node) => node.kind === 'controllerDependencies');
      assert.ok(group);
      assert.equal(tree.getTreeItem(group).label, 'Dependencies');
      assert.deepEqual(tree.getParent(group), controller);
      const entries = tree.getChildren(group);
      assert.deepEqual(entries.map((node) => tree.getTreeItem(node).label), [
        'WickerDependencyContract', 'WickerDependencyEntity', 'WickerDependencyOther',
        'WickerDependencyRepository', 'WickerDependencyService', 'WickerDependencyStatus',
      ]);
      const iconIds = [...entries, controller, group].map((node) => (tree.getTreeItem(node).iconPath as vscode.ThemeIcon).id);
      assert.equal(new Set(iconIds).size, iconIds.length, 'Each kind of object has a distinct icon');
      const service = entries.find((node) => node.kind === 'controllerDependency' && node.typeName.endsWith('WickerDependencyService'))!;
      const item = tree.getTreeItem(service);
      assert.equal(item.description, '$worker, $alsoWorker');
      assert.ok(typeof item.tooltip === 'string' && item.tooltip.includes('__construct()') && item.tooltip.includes('related()'));
      assert.deepEqual(tree.getParent(service), group);
      await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
      target = vscode.window.activeTextEditor!.document;
      assert.equal(target.uri.toString(), uri(files[0][0]).toString());
      assert.equal(target.getText(vscode.window.activeTextEditor!.selection), 'WickerDependencyService');
      await replace(target, `<?php\n// unsaved line shift\n\n${files[0][1].slice(6)}`);
      await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
      assert.equal(target.getText(vscode.window.activeTextEditor!.selection), 'WickerDependencyService');
      await replace(target, target.getText().replace('class WickerDependencyService', 'class RenamedService'));
      assert.ok(!tree.getChildren(group).some((node) => node.kind === 'controllerDependency' && node.typeName.endsWith('WickerDependencyService')));
      await replace(target, files[0][1]);
      const duplicate = uri('src/Controller/WickerDependencyDuplicate.php');
      try {
        await vscode.workspace.fs.writeFile(duplicate, Buffer.from(files[0][1]));
        await eventually(() => !tree.getChildren(group).some((node) => node.kind === 'controllerDependency' && node.typeName.endsWith('WickerDependencyService')));
      } finally { await vscode.workspace.fs.delete(duplicate); }
      await eventually(() => tree.getChildren(group).some((node) => node.kind === 'controllerDependency' && node.typeName.endsWith('WickerDependencyService')));
      await vscode.workspace.fs.delete(uri(files[1][0]));
      await eventually(() => !tree.getChildren(group).some((node) => node.kind === 'controllerDependency' && node.typeName.endsWith('WickerDependencyRepository')));
      await replace(php, phpSource);
      assert.ok(!tree.getChildren(controller).some((node) => node.kind === 'controllerDependencies'), 'Empty dependency groups disappear after unsaved edits');
      await replace(php, injected);
      await settings.update('enable', false, vscode.ConfigurationTarget.Workspace);
      assert.deepEqual(tree.getChildren(group), []);
      await vscode.window.showTextDocument(page);
      await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
      assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), page.uri.toString(), 'Stale commands respect wicker.enable');
    } finally {
      await settings.update('enable', previous, vscode.ConfigurationTarget.Workspace);
      await replace(php, phpSource);
      if (target) { await vscode.window.showTextDocument(target); await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor'); }
      await deleteDependencyFiles(files.map(([file]) => uri(file)));
      tree.dispose(); sessions.dispose();
    }
  });
  test('Twig and controller script branches share links and prefer verified TypeScript sources', async () => {
    const tsPath = 'assets/controllers/wicker_test_controller.ts';
    const mapPath = `${JS}.map`;
    const includedPath = 'templates/wicker_script_include.html.twig';
    const memory = new Map<string, unknown>();
    const sessions = new SessionManager(new LoaderPathMemory({ keys: () => [...memory.keys()],
      get: <T>(key: string, fallback?: T): T | undefined => memory.get(key) as T | undefined ?? fallback,
      update: (key, value) => { memory.set(key, value); return Promise.resolve(); } }));
    const tree = new ProjectTreeProvider(sessions);
    let ts: vscode.TextDocument | undefined;
    try {
      await sessions.initialize();
      const root = tree.getChildren().find((node) => node.root.toString() === uri('').toString())!;
      const leaf = { kind: 'template' as const, root: root.root, name: TWIG.slice(10) };
      const initial = tree.getChildren(leaf);
      assert.equal(initial.length, 1);
      assert.equal(initial[0]!.kind, 'script');
      assert.equal(tree.getTreeItem(initial[0]!).label, 'wicker_test_controller.js');
      assert.deepEqual(tree.getParent(initial[0]!), leaf);
      assert.equal(tree.getTreeItem(leaf).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
      assert.ok(leafIconPath(tree.getTreeItem(leaf)).endsWith('/template-leaf-dark.svg'));
      const controllers = tree.getChildren(root).find((node) => node.kind === 'section' && node.section === 'controllers')!;
      const controller = tree.getChildren(controllers).find((node) => node.kind === 'controller' && node.className.endsWith('WickerFrontendTestController'))!;
      const group = tree.getChildren(controller).find((node) => node.kind === 'controllerScripts');
      assert.ok(group);
      assert.equal(tree.getTreeItem(group).label, 'Scripts');
      assert.deepEqual(tree.getParent(group), controller);
      const controllerScript = tree.getChildren(group).find((node) => node.kind === 'script' && node.projectPath === JS);
      assert.ok(controllerScript);
      assert.notEqual(tree.getTreeItem(controllerScript).id, tree.getTreeItem(initial[0]!).id);
      const item = tree.getTreeItem(controllerScript);
      await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
      assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), js.uri.toString());
      // A same-named TS file that independently calls the route is kept until
      // the compiled JS explicitly names a map pointing at that source.
      await vscode.workspace.fs.writeFile(uri(tsPath), Buffer.from("fetch('/_wicker-test/fragment');"));
      ts = await vscode.workspace.openTextDocument(uri(tsPath));
      assert.equal(tree.getChildren(leaf).length, 1);
      await eventually(() => tree.getChildren(group).filter((node) => node.kind === 'script').length === 2);
      const scriptIcons = tree.getChildren(group).map((node) => (tree.getTreeItem(node).iconPath as vscode.ThemeIcon).id);
      assert.equal(new Set(scriptIcons).size, 2, 'Independent JS and TS files have distinct icons');
      await vscode.workspace.fs.writeFile(uri(mapPath), Buffer.from(JSON.stringify({ version: 3,
        sources: ['wicker_test_controller.ts'], names: [], mappings: '' })));
      await replace(js, `${jsSource}\n//# sourceMappingURL=wicker_test_controller.js.map`);
      await eventually(() => tree.getChildren(leaf).some((node) => node.kind === 'script' && node.projectPath === tsPath));
      assert.equal(tree.getChildren(group).length, 1, 'Generated JS and its TS source collapse into one entry');
      const preferred = tree.getChildren(leaf)[0]!;
      const preferredItem = tree.getTreeItem(preferred);
      assert.ok(typeof preferredItem.tooltip === 'string' && preferredItem.tooltip.includes(JS));
      await vscode.commands.executeCommand(preferredItem.command!.command, ...preferredItem.command!.arguments!);
      assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), ts.uri.toString());
      await replace(page, '<p>No scripts here</p>');
      assert.deepEqual(tree.getChildren(leaf), []);
      await vscode.window.showTextDocument(page);
      await vscode.commands.executeCommand(preferredItem.command!.command, ...preferredItem.command!.arguments!);
      assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), page.uri.toString(), 'Stale associations do not navigate');
      // Literal includes carry their bindings, with cycles bounded by file identity.
      await vscode.workspace.fs.writeFile(uri(includedPath), Buffer.from(`${pageSource}\n{% include '${TWIG.slice(10)}' %}`));
      await replace(page, `{% include '${includedPath.slice(10)}' %}`);
      await vscode.commands.executeCommand('wicker.reindex');
      await sessions.refreshAll();
      await eventually(() => tree.getChildren(leaf).length === 1);
      assert.ok(leafIconPath(tree.getTreeItem(leaf)).includes('template-leaf'));
      await vscode.workspace.fs.delete(uri(mapPath));
      await eventually(() => tree.getChildren(leaf).some((node) => node.kind === 'script' && node.projectPath === JS));
    } finally {
      await replace(page, pageSource); await replace(js, jsSource);
      if (ts) { await vscode.window.showTextDocument(ts); await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor'); }
      await deleteDependencyFiles([uri(tsPath), uri(mapPath), uri(includedPath)]);
      tree.dispose(); sessions.dispose();
    }
  });
  test('creating and deleting a controller refreshes Stimulus without a manual rebuild', async () => {
    const added = uri('assets/controllers/wicker_added_controller.js');
    const position = await at(page, '<div data-controller="§">');
    try {
      await vscode.workspace.fs.writeFile(added, Buffer.from('export default class { run() {} }'));
      await eventually(async () => (await items(page, position)).some((item) => item.label === 'wicker-added'));
      await vscode.workspace.fs.delete(added);
      await eventually(async () => !(await items(page, position)).some((item) => item.label === 'wicker-added'));
    } finally { try { await vscode.workspace.fs.delete(added); } catch { /* Already removed. */ } }
  });
  test('saved PHP registration changes remove stale route navigation automatically', async () => {
    const position = await at(page, `{{ path('wicker_test_js§on') }}`);
    assert.ok((await definitions(page, position)).length);
    try {
      await replace(php, phpSource.replace("name: 'wicker_test_json'", "name: 'renamed'"));
      assert.ok(await php.save());
      await eventually(async () => (await definitions(page, position)).length === 0);
    } finally { await replace(php, phpSource); await php.save(); await vscode.commands.executeCommand('wicker.reindex'); }
  });
  test('asset() completes and opens mapped files, and importmap() offers only entrypoints', async () => {
    // The controller written by this suite lives under the configured root, so
    // the asset map should know it by its logical path.
    const logical = 'controllers/wicker_test_controller.js';

    const assetPosition = await at(page, `<link href="{{ asset('§') }}">`);
    await eventually(async () => (await items(page, assetPosition)).some((item) => item.label === logical));

    const opened = await definitions(page, await at(page, `<link href="{{ asset('${logical}§') }}">`));
    assert.equal(opened.length, 1);
    assert.ok(opened[0]!.targetUri.path.endsWith(JS), `expected ${JS}, got ${opened[0]!.targetUri.path}`);

    // An entrypoint is a key of importmap.php, not a logical path. Offering
    // logical paths here would suggest names importmap() cannot take.
    const entrypoint = await at(page, `{{ importmap('§') }}`);
    const offered = (await items(page, entrypoint)).map((item) => item.label);
    assert.ok(!offered.includes(logical), 'a logical asset path is not an entrypoint');
  });

  test('import specifiers navigate, by importmap alias and by relative path', async () => {
    const original = js.getText();
    try {
      // A relative specifier names a file directly; the peer controller this
      // suite writes sits beside the importing file.
      const relative = './wicker_peer_controller.ts';
      const withImport = `import peer from '${relative}';\n${original}`;
      await replace(js, withImport);
      const at = js.positionAt(withImport.indexOf(relative) + 2);
      const links = await definitions(js, at);
      assert.equal(links.length, 1);
      assert.ok(links[0]!.targetUri.path.endsWith(PEER), `expected ${PEER}, got ${links[0]!.targetUri.path}`);

      // Completion inside the quotes offers what importmap.php declares, which
      // is the only way a bare specifier can resolve at all.
      assert.ok((await items(js, at)).some((item) => item.label === '#fixture/peer'),
        'the importmap alias should be offered inside an import');

      // And the alias itself navigates. This is the form that replaces the
      // relative climb, so it has to reach the same file.
      const alias = '#fixture/peer';
      const withAlias = `import peer from '${alias}';\n${original}`;
      await replace(js, withAlias);
      const aliasLinks = await definitions(js, js.positionAt(withAlias.indexOf(alias) + 2));
      assert.equal(aliasLinks.length, 1);
      assert.ok(aliasLinks[0]!.targetUri.path.endsWith(PEER), `expected ${PEER}, got ${aliasLinks[0]!.targetUri.path}`);
    } finally {
      await replace(js, original);
    }
  });

  test('reports imports the browser could not resolve, and only those', async () => {
    const original = js.getText();
    const messages = async (): Promise<string[]> => {
      await eventually(() => vscode.languages.getDiagnostics(js.uri).length > 0);
      return vscode.languages.getDiagnostics(js.uri).map((entry) => entry.message);
    };
    try {
      await replace(js, [
        `import a from './wicker_peer_controller.ts';`,   // relative, exists
        `import b from '#fixture/peer';`,                 // importmap alias
        `import c from '@hotwired/stimulus';`,            // importmap package
        `import d from './gone.js';`,                     // relative, no such asset
        `import e from './wicker_peer_controller';`,      // no file extension
        `import f from 'never-declared';`,                // in no importmap entry
        original,
      ].join('\n'));

      const found = await messages();
      // Named individually: the point is which ones are quiet, not the count.
      assert.ok(found.some((text) => text.includes('./gone.js')), 'a missing relative target');
      assert.ok(found.some((text) => text.includes('no file extension')), 'an extension-less relative import');
      assert.ok(found.some((text) => text.includes('never-declared')), 'a bare specifier in no entry');

      for (const quiet of ['./wicker_peer_controller.ts', '#fixture/peer', '@hotwired/stimulus']) {
        assert.ok(!found.some((text) => text.includes(`"${quiet}"`)), `${quiet} resolves and must not be reported`);
      }
    } finally {
      await replace(js, original);
    }
  });

  test('completes every part of an action descriptor, not just the method', async () => {
    const offers = async (marked: string): Promise<string[]> =>
      (await items(page, await at(page, marked))).map((item) => item.label as string);

    assert.ok((await offers('<button data-action="§->wicker-test#refresh"></button>')).includes('click'),
      'the event position should offer DOM events');
    assert.ok((await offers('<button data-action="keydown.§->wicker-test#refresh"></button>')).includes('enter'),
      'the key filter position should offer filters');
    assert.ok((await offers('<button data-action="scroll@§->wicker-test#refresh"></button>')).includes('window'),
      'the target position should offer window and document');
    assert.ok((await offers('<button data-action="click->wicker-test#refresh:§"></button>')).includes('prevent'),
      'the option position should offer action options');

    // The method position still resolves against the controller rather than
    // being taken over by the descriptor vocabularies.
    assert.ok((await offers('<button data-action="click->wicker-test#§"></button>')).includes('refresh'),
      'the method position should still offer controller actions');
  });

  test('connects a dispatched event to the action listening for it', async () => {
    const originalJs = js.getText();
    try {
      // Stimulus composes "<identifier>:<name>", so this controller emits
      // wicker-test:refreshed. Neither file mentions the other.
      await replace(js, jsSource.replace('async refresh()',
        "notify() { this.dispatch('refreshed'); }\n  async refresh()"));

      const eventPosition = await at(page, '<div data-action="§->wicker-test#refresh"></div>');
      await eventually(async () => (await items(page, eventPosition))
        .some((item) => item.label === 'wicker-test:refreshed'));

      const listening = await at(page, '<div data-action="wicker-test:refreshed§->wicker-test#refresh"></div>');
      const links = await definitions(page, listening);
      assert.equal(links.length, 1, 'the composed event name should open its dispatch call');
      assert.ok(links[0]!.targetUri.path.endsWith(JS), `expected ${JS}, got ${links[0]!.targetUri.path}`);
    } finally {
      await replace(js, originalJs);
    }
  });

  test('completes and navigates the properties Stimulus generates', async () => {
    const original = js.getText();
    try {
      const withClasses = jsSource
        .replace('static targets', "static classes = ['busy'];\n  static targets")
        .replace('async refresh()', 'use() { this.\n  }\n  async refresh()');
      await replace(js, withClasses);
      const caret = js.positionAt(withClasses.indexOf('this.\n') + 5);

      // Declared nowhere: Stimulus creates these at runtime, so no other tool
      // in the editor knows they exist.
      const offered = (await items(js, caret)).map((item) => item.label as string);
      for (const generated of ['outputTarget', 'hasOutputTarget', 'urlValue', 'busyClass', 'hasBusyClass']) {
        assert.ok(offered.includes(generated), `${generated} should be offered after this.`);
      }

      // And each one leads back to the declaration it was generated from.
      const marked = withClasses.replace('this.\n', 'this.busyClass;\n');
      await replace(js, marked);
      const links = await definitions(js, js.positionAt(marked.indexOf('this.busyClass') + 7));
      assert.equal(links.length, 1);
      assert.equal(js.getText(links[0]!.targetRange), 'busy');
    } finally {
      await replace(js, original);
    }
  });

  test('nested Twig bindings cannot supply JSON fields to the parent project', async () => {
    const nested = await vscode.workspace.openTextDocument(uri('nested-app/templates/task/_row.html.twig'));
    const original = nested.getText();
    try {
      await replace(page, '');
      await replace(nested, pageSource);
      const position = js.positionAt(js.getText().indexOf('data.message') + 7);
      assert.ok(!(await items(js, position)).some((item) => item.detail?.startsWith('JSON response')));
    } finally {
      await replace(nested, original);
      await vscode.window.showTextDocument(nested);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });
});

async function deleteDependencyFiles(files: readonly vscode.Uri[]): Promise<void> {
  for (const file of files) {
    try { await vscode.workspace.fs.delete(file); }
    catch (error) { if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') { throw error; } }
  }
}

function leafIconPath(item: vscode.TreeItem): string {
  assert.ok(item.iconPath && typeof item.iconPath === 'object' && 'dark' in item.iconPath);
  assert.ok(item.iconPath.dark instanceof vscode.Uri);
  return item.iconPath.dark.path;
}
