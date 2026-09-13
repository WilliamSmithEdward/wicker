Please adopt the following foundations into your context:

F:\GitHub\RIDM_Recursive_Invariant_Discovery_Model\RIDM.MD
F:\GitHub\AI_Best_Practices\docs\agentic_ai_programming_best_practices.md
F:\GitHub\AI_Best_Practices\docs\ai_smells_for_agents_to_avoid.md
F:\GitHub\AI_Best_Practices\docs\ui_ux_guidelines_for_agents.md

## Project: Wicker

A VS Code extension for Symfony and Twig. See README.md for what it does and
why. This file is the operational detail an agent needs before editing.

Published on the marketplace as `WilliamSmithE.wicker`, source at
https://github.com/WilliamSmithEdward/wicker. The first capability, the bridge
between a controller and the template it renders, is finished and shipped.
Releases are `vX.Y.Z` for both the tag and the release title, nothing else in
the title.

### Constraints that are not negotiable

**The extension ships no third-party runtime code.** Not a preference, a
requirement. The Twig lexer, the PHP lexer and the YAML reader were written for
this project because `php-parser` and `yaml` were dependencies. Build tooling is
exempt and stays conventional: esbuild, vitest, eslint, vsce are all fine as dev
dependencies. If a runtime dependency looks necessary, write the subset instead
and say why in the code.

**Never name a competing extension.** Their features are fair to study for
ideas. Their names and their source must not appear in this repository, in
commit messages, in the marketplace listing, or in anything else a user can see.

**Confirm a package exists before adding it.** Model-invented package names are
an active supply-chain attack vector.

### Commands

    npm install                          once, Node 20.19+
    npm run check                        the gate: build, typecheck, lint, test
    npm test                             unit tests only
    npm run lint:fix                     apply lint fixes
    npm run test:integration -w wicker   drives a real VS Code instance
    npm run vsix -w wicker               builds the .vsix into dist/

`check` builds first on purpose: the extension type checks against the engine's
emitted declarations, so a check without a build passes locally and fails in CI.

`test:integration` is the one that proves a feature actually works. It launches
VS Code against `packages/vscode/fixtures/symfony-app` and calls the same
provider commands the editor calls. A unit test cannot tell you that a provider
is registered correctly, and several bugs here were invisible until this ran.

### Layout

    packages/core      the engine: no editor or protocol dependencies
    packages/server    LSP server over the engine (not started)
    packages/vscode    the VS Code extension

Tests sit beside the code as `*.test.ts` under vitest. Integration tests live in
`packages/vscode/src/test/` and are excluded from vitest, since they need the
VS Code host. `tsconfig.json` in each package type checks everything including
tests; `tsconfig.build.json` emits and excludes them.

### Conventions that are load-bearing

**Paths inside the engine are project-relative and forward-slashed.** Absolute
paths appear only as a project root. This is what keeps one index valid when
Symfony sees `/app` inside its container and the editor sees a Windows drive or
a WSL UNC path. Do not introduce absolute paths into the index.

**Core returns character offsets, not line and column.** The editor layer
converts using the document's line index, so UTF-16 arithmetic lives in exactly
one place.

**Symfony's own `debug:*` commands are the source of truth**, and they report
loader paths relative to the project root. Treat their output as untrusted: it
is parsed defensively and a malformed payload degrades to a fallback rather than
throwing.

**TypeScript 6 does not auto-discover hoisted `@types`**, so `types` is declared
explicitly in `tsconfig.base.json`. A package that contributes globals must be
added there. TypeScript 7 is not usable yet: `typescript-eslint` peer-caps below
it.

**Every feature resolves its project through `SessionManager.sessionFor`.** That
is deliberate. It is the single gate where `wicker.enable` turns everything off
at once. A new provider that reaches around it will keep running when the user
has switched the extension off.

### Things that have already gone wrong

Each of these cost real time. They are written down so they cost it once.

**`uri.path` is not `uri.fsPath` on Windows.** `folder.uri.path` yields
`/F:/GitHub/...`, which matches nothing. Every integration test failed silently
until `enginePathOf()` in `packages/vscode/src/paths.ts` started using `fsPath`
for file-scheme URIs. Always go through that helper.

**Never run `asset-map:compile` in the demo app.** It writes the whole asset map
into `public/assets/`, the web server then serves those files directly, and
AssetMapper stops running. Every later edit becomes invisible, and because the
compiled filenames keep the hash they had at compile time the URL does not
change either, so nothing looks wrong. The directory is gitignored, so it leaves
no trace to explain the behaviour. If the site appears frozen on old CSS, check
`ls public/assets` first. The fix is `rm -rf public/assets`. The command belongs
in a production build step only.

**Twig comments do not nest.** A `{# ... #}` marker inside a commented-out block
terminates the outer comment early and the rest becomes live template code.

**Shiki identifies a language by the grammar's `name` field**, which in
`twig.tmLanguage.json` is the display name `Twig`. The demo app re-registers it
as `twig`. The worse bug was the silent `catch` around it, which made a broken
highlighter indistinguishable from an absent one.

**VS Code resolves overlapping extensions per feature, and two are exclusive.**
Hover, definition and code actions merge across providers. Completion groups
providers by selector score and stops at the first group that returns anything,
so a lower-scoring provider is never called. Semantic tokens select one provider
outright. This is why general PHP language support is out of scope, and it is
worth checking before adding any feature that competes for those slots.

**Do not use a shell heredoc.** Write files with the Write tool and edit them
with Edit. Heredocs mangle backslashes on the way through the shell and the
damage surfaces far from its cause.

### Test environment

The live Symfony app used for human verification is Symfony 8.1 on PHP 8.5 in
Docker. It is a separate project, not part of this repository:

    source        /home/william/projects/symfonyApp   (WSL Ubuntu)
    from Windows  //wsl.localhost/Ubuntu/home/william/projects/symfonyApp
    container     symfonyapp-php-1, project mounted at /app
    url           https://localhost  (self-signed, curl needs -k)

There is no PHP on the Windows host. Run console commands through the container:

    docker exec symfonyapp-php-1 php bin/console debug:twig --format=json

The containers stop when Docker or WSL restarts. A yellow Wicker status bar
means the console is unreachable; `docker compose up -d` from the project
directory brings it back.

That app uses AssetMapper, Tailwind 4, Stimulus, Turbo and React via Symfony UX,
and carries a three-part tour under `/wicker` built to exercise the extension.
`assets/wicker/twig.tmLanguage.json` is a manual copy of the extension's grammar
and `assets/wicker/dark-2026.color-theme.json` is VS Code's Dark 2026 theme with
its include chain flattened. Both drift if the originals change.

To drive the extension against it:

    npm run build -w wicker
    code --extensionDevelopmentPath=F:\GitHub\wicker\packages\vscode \\wsl.localhost\Ubuntu\home\william\projects\symfonyApp

Grant workspace trust when prompted, or the console integration will not run.

That project's `.vscode/settings.json` already carries the setting that makes
this work, and any containerised project needs its equivalent:

    "wicker.console.command": ["docker", "exec", "symfonyapp-php-1", "php", "bin/console"]

Without it Wicker falls back to `config/packages/twig.yaml` and cannot resolve
bundle namespaces such as `@Twig` or `@Turbo`, which are declared in no
configuration file. The symptom is a yellow status bar and a lower template
count. Opening the project inside the dev container instead puts PHP on PATH
and the setting can be dropped.

### Verifying by hand

The integration suite covers the providers, but it runs against a fixture. A
change to anything user-facing should also be looked at in the real app.

`src/Controller/WickerTourController.php` in the demo project is written as a
numbered tour and is the fastest route through every feature. Work down it:

- A `render()` call with three context keys. Hover the template name: the file,
  the kind of reference, and those three variables. Ctrl-click opens it.
- A `#[Template]` attribute instead of a `render()` call.
- A method with no route holding two broken names. They must report
  differently, a missing file against an unregistered namespace, and the quick
  fix must offer to create the first and decline the second.
- A name built at runtime by concatenation. It must report nothing at all.

Then `templates/wicker/navigation.html.twig` for the Twig side: `extends`, a
namespaced `include`, the `include()` function and an `embed`, each
ctrl-clickable.

Template names that resolve should be coloured differently from ordinary
strings. Names that do not resolve must keep the plain string colour, or the
colour claims an understanding the extension does not have.

The status bar reads `Wicker` and is not yellow when the console is reachable.
Its tooltip says where the namespaces came from, and clicking it opens the
project detail.

The first `test:integration` run downloads a VS Code build into
`packages/vscode/.vscode-test/`, so it takes minutes rather than seconds. That
is not a hang.

### Releasing

1. `npm run check` and `npm run test:integration -w wicker`, both green.
2. Bump the version in both package manifests and add a CHANGELOG entry.
3. `npm run vsix -w wicker`.
4. Commit, then tag `vX.Y.Z` and push the tag.
5. `gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <notes> <the .vsix>`.
6. Publish with the script pattern in the next paragraph.

The marketplace token is in the `Azure_DevOps_PAT` user environment variable.
Pass it to vsce as `VSCE_PAT` inside the process, never on a command line and
never in output. Publish with `--packagePath` pointing at the artifact already
attached to the release, so the marketplace and GitHub serve identical bytes.

`packages/vscode/.vscodeignore` is written as exclude-everything-then-allow. A
forgotten exclusion publishes something by accident and a marketplace version
can never be replaced, while the other direction fails loudly on first run. The
package should be around 11 files: the bundle, the grammars, the language
configuration, the icon, and the three documents copied in by
`scripts/package.mjs`.

### Out of scope

**PHP as a general language.** Navigation, completion and diagnostics across a
PHP codebase at large are deliberately not planned. Completion and semantic
tokens select a single provider, so competing there either replaces a mature
implementation or ships features that silently never run. Wicker expects to sit
alongside a PHP extension rather than instead of one. The README explains this
where users will find it.

The roadmap in README.md is the current plan, built one capability at a time
with each finished before the next starts.
