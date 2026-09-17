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

### Product vision and experience principles

Wicker's ultimate vision is to be a one-stop shop for Symfony and Twig
development, with a developer experience that is a joy to use and lowers
cognitive load as much as possible. Use this as the basis for product, roadmap
and interaction decisions.

Explore that experience through real use and iteration. The user does not need
to arrive with a fixed list of pain points: propose concrete improvements, try
them in the live app, and learn what makes Symfony development feel better.

Initial project and environment setup is outside the product's intended scope.
Once a project is set up, the ambition is broad: everyday Symfony and Twig
development may include creating application code, refactoring, running project
commands, testing and debugging, as well as editor intelligence. These are areas
to explore, not promised features or a change to the roadmap's delivery order.

- Serve beginners and experienced developers through one coherent experience.
  Make concepts and actions discoverable, with explanations available when
  needed and efficient interactions that remain unobtrusive as familiarity grows.
- Connect related parts of an application through consistent navigation,
  completion and explanations: controllers, templates, routes, services,
  components and frontend integrations such as Stimulus.
- Reduce what developers must remember, search for, configure or switch between.
  For each proposed feature, name the concrete workflow and the friction it
  removes. Judge the result by that workflow from start to finish, including
  how clear and pleasant it feels to use.
- Discover what the project provides and keep editor surfaces current as files
  change. Normal editing should not require manual reindexing or window reloads.
- Keep the default interface calm. Use familiar VS Code controls, show relevant
  information where the developer is working, and reveal deeper detail on
  demand. Every persistent label, count, warning and action should earn its place.
- Make assistance trustworthy: ground claims in project evidence, explain
  uncertainty, and provide clear recovery when discovery is incomplete. Avoid
  speculative diagnostics that create extra work for the developer.
- Prefer sensible defaults, accessible keyboard interactions and consistent
  behavior across features. Preserve user preferences as coverage expands.

### Documentation and roadmap scope

Use these official documentation sites as primary references:

- [Twig 3.x](https://twig.symfony.com/doc/3.x/)
- [Symfony](https://symfony.com/doc)

The user explicitly authorizes comprehensive browsing and crawling of these
sites and their linked official documentation as needed for research and
implementation. Check documentation against the project's installed versions;
Symfony's runtime discovery remains the authority for what that app provides.

Wicker's roadmap covers the wider Symfony ecosystem, including Symfony UX and
Stimulus integration with Twig. Keep Stimulus explicit in README.md's roadmap.
Deliver one capability at a time; a roadmap entry is planned support, not a
claim that the feature has shipped. General PHP language support remains out
of scope as described below.

The next sprint after v0.4.0 is full Stimulus and AssetMapper coverage and
ergonomics, explicitly including outlets. Its user-facing goal is to make an
existing project understandable and pleasant for someone who has never used
these tools, with minimal cognitive load. See
[the sprint scope](docs/sprint-stimulus-assetmapper.md) for coverage, delivery
order and completion criteria. Teach connections in context with concise
explanations, real project navigation and concrete repair edits. Finish the
coverage audit before calling this sprint complete; basic name completion alone
does not meet the goal.

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

**Template context and direct render sites are different facts.**
`TemplateContextIndex` follows literal Twig includes and inheritance for variable
suggestions; `RenderSiteIndex` and the Rendered by links describe direct PHP
calls only. Keep both PHP and Twig sources within the owning session. Twig text
changes are tracked independently of console discovery, including unsaved edits.

**Component registrations come from `debug:twig-component`.** UX 2.x and 3.x
expose a table, not a JSON formatter; read its unstyled four-column rows
defensively. Do not guess registrations from directory conventions. Prop
suggestions read the registered source's current editor buffer. They cover
direct declarations, not PHP inheritance or dynamic lifecycle hooks.

**Frontend connections follow explicit source evidence.** StimulusBundle has no
`debug:stimulus` command. Read `debug:config stimulus --format=json` and
`debug:container --parameter=kernel.project_dir --format=json`, then map paths
to project-relative form. Controller identifiers follow its configured folders
and JS/TS filename conventions; enabled UX controllers use package metadata.
Routes come from `debug:router --format=json`. Never infer JSON from an `/api`
prefix or call an endpoint to inspect data. Browser-fetched JSON belongs to JS,
including inline Twig scripts, not automatically to server-side Twig variables.
PHP `#[` is one lexer token: any balanced-token reader shared with JS must
account for it or real attributed controller methods silently disappear.

**Controller dependencies are declared types, not a reconstructed container.**
The tree resolves direct parameter/property types against owned PHP declarations.
It must not invent an implementation for an interface or follow another session's
sources. Namespace roles affect icons only. Associated scripts follow explicit
Stimulus/template/route links. Prefer TS in the tree only when a local source map
identifies one existing source; matching JS/TS basenames alone are not proof.

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

**A template appearing can change what the console reports.** A rebuild runs
about seven `bin/console` commands, each a kernel boot, so a refresh carries a
scope: a `.twig` file created or deleted rebuilds the template index and leaves
the console alone, while PHP, scripts and configuration ask everything again.
The exception that makes this hard is that anonymous Twig components *are*
template files and `debug:twig-component` enumerates them, so a template under
a components directory is an environment change. The test that guards it is
`creating and deleting an anonymous component updates discovery`. Two changes
waiting together are answered at the wider scope, and a pass takes its scope at
the start so a change arriving mid-pass widens the next one.

**The tree used to wait for the console.** A session was constructed only
after every console command had answered or hit its fifteen-second cap, so
on a remote machine with a cold cache six kernel boots at once timed out
together, the project appeared late, and every console-backed section came
up as unavailable until a retry ran against the cache those boots had warmed.
A session is now built from the files first and published, and the console
is asked by the first refresh with a minute to answer; `consolePending` is
what the sidebar reads to show a waiting row instead of warnings. Keep that
order: publish, then ask. What the console said last time is remembered per
command in workspace state and stands in for that first pass. The three
configuration answers are kept for the pass and confirmed against the console
after it has been published, so a first open boots the kernel three times
before anything visible and three times after. Routes and components are
remembered only until the console answers, because their absence breaks
nothing while a stale list would say a route added since does not exist. The
status bar shows progress for the read only: asking the console and confirming
what was remembered have none, because nothing waits for them and a spinner
through both read as a hang. Show diagnostics prints how long each command
took, which is the first thing to ask for when someone says an open is slow.

**`importmap.php` is not always the whole import map.** A project replaced
`asset_mapper.importmap.config_reader` with a reader that generates a
`#app/<logical path>` alias for every file it authors and never writes them
down. Every such import was reported as unresolvable, and the chain from an
entrypoint stopped at the first one, so the scripts and styles under its
templates were missing. Where the project's configuration or PHP names that
service, bare imports are not checked and a `#` alias is followed to the
mapped asset its remainder names. Without that evidence the same alias is one
the browser cannot resolve, and following it would invent a resolution.

**A memo has to be keyed on everything its answer was read from.** The Stimulus
wiring memo was keyed on the scanned-file index and the controller list, but the
walk resolves names through the template index, which the scoped refresh above
replaces on its own. A template that appeared was walked once as unresolved and
the empty answer kept for as long as no scanned file changed. It looked right
for as long as every refresh replaced everything.

**A fixture shared by two workspace projects needs to say which project it
means.** Both projects run the fake console, and the nested one, reading the
probe from its own directory, wrote `price` over a marker the root had written
`before_change` into. The old full second pass re-spawned the root console and
rewrote the marker last, so the race was won by accident until the second pass
went away. `a PHP change during a slow console run is not lost` now writes its
marker from the root project only.

**`session.uriOf()` takes a project-relative path; the root is not one.** It
joins its argument onto the project root, so `uriOf(session.project.root)`
names `root/root`, matches nothing, and the whole tree comes up empty. The
root's own URI is `session.fileSystem.toUri(session.project.root)`, which is
what the seven places that need it use. Nine sidebar tests failed the one time
this was written the other way, which is the right number.

**`vscode.executeCodeLensProvider` costs about ten milliseconds of its own.**
A benchmark through that command showed 14ms a call and the provider was
suspected; timed inside, `provideCodeLenses` costs 0.03ms. The command's own
round trip and lens handling is the rest. Measure a provider inside the
provider before optimising it.

**`@vscode/test-electron` is imported by nothing and still required.** It is
listed beside `@vscode/test-cli`, which loads it at run time without declaring
it, so the lockfile resolves without it and a dependency scan calls it dead.
Removing it makes `vscode-test` fail to launch the editor. It stays.

**A keystroke schedules a re-parse; `sessionFor` applies it.** Each tracker
defers a changed document's re-index 300ms, and `SessionManager.sessionFor`
settles the matched session before returning it, which is what keeps every
provider exact mid-typing. A reader that reaches a tracker's index without
going through `sessionFor` sees the text as it was up to 300ms ago. Five tests
that assert a provider result immediately after an unsaved edit fail without
the settle, which is how the guarantee is kept honest.

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

**The integration suite edits fixture files while it runs**, and restores them
in teardown. An interrupted run leaves one modified, and `git add -A` then
commits it as though it were work. That has happened twice: a
`.vscode/settings.json` written by a settings test, and
`fixtures/.../Alert.php` renamed by a component test, which left five tests
failing on a fixture in the wrong state. Read `git status` before staging, and
treat a changed fixture you did not edit as a leftover rather than a change.

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

The containers stop when Docker or WSL restarts. The Wicker sidebar's project
tooltip reports whether namespaces came from the console, a remembered answer,
or configuration. If the console is unreachable, `docker compose up -d`
from the project directory brings the containers back.

That app uses AssetMapper, Tailwind 4, Stimulus, Turbo, React and Twig Components via Symfony UX,
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
configuration file. The sidebar reports configuration as the namespace source
and a lower template count. Opening the project inside the dev container instead
puts PHP on PATH and the setting can be dropped.

### Verifying by hand

After each completed implementation change, run the build and launch commands
for the user: build all packages, then open the real Symfony app in a VS Code
Extension Development Host using this checkout. Launch only if the build
succeeds. If the development host is already open, reload it to load the latest
build. Repeating `code.cmd` with the same `--extensionDevelopmentPath` reloads
the existing development host, so UI automation is not needed for this step.
This is authorized; do not ask again or substitute a launch snippet.
Use `npm.cmd` and `code.cmd` explicitly: PowerShell script execution is disabled
on this machine, so `npm` can select a blocked `npm.ps1` launcher.
In the final response, confirm the test window is ready and give a short,
change-specific live-test checklist naming the files, actions and expected
results. Include how to undo temporary test edits. Automated test results do
not replace this handoff.

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

The Wicker sidebar's project tooltip reports Symfony console when it is reachable.
Healthy projects contain Controllers and Templates sections. Under Controllers,
expand TaskController, then its index action (labelled by its route when known): clicking the action selects its PHP template
name and clicking the template opens Twig. WickerTourController includes both
render calls and a Template attribute. Unresolved names remain visible with a
warning. A controller is listed when it renders a template or a route names
it, and an action that renders nothing opens where it is declared. The tree follows
unsaved PHP edits; undo temporary edits after checking this.
Limited namespace discovery or a truncated index shows an expandable warning
with Retry and Settings actions.
Right-click the project and choose Show diagnostics for its report in Output.
Wicker has no persistent status bar item.

For Twig Components, open `templates/wicker/components.html.twig` in the demo.
`WickerNotice` has a PHP class and template; `WickerBadge` is anonymous. Complete
names after `<twig:`, use Go to Definition on a component or prop, and change a
prop declaration without saving to verify that completion follows the buffer.
The examples render on `/wicker`. Undo temporary test edits afterward.

For controller dependencies, expand TaskController → Dependencies: TaskRepository
and Task should open their declarations. DashboardController's repository comes
from its index parameter instead of a constructor. Twig files use a leaf icon;
Twig routes use a leaf with a route arrow. Expand templates/wicker/stimulus.html.twig
to open its associated wicker_api_controller.js, or find it under
WickerTourController → Scripts through the included tour template.

The current outlet development increment is demonstrated in
`templates/wicker/outlets.html.twig`, included on `/wicker`. Its
`controllerOutlets` key and selector open the declaring
`assets/controllers/wicker_outlet_controller.js` and receiving
`assets/controllers/wicker_counter_controller.js`. In the sender, complete
after `this.`, hover `hasWickerCounterOutlet`, navigate `increment`, and use Find
All References on the static outlet name. The page's Add one button calls the
counter beside the sender; Reset counter returns it to zero. Temporarily change
the selector to `#missing`, save and reload to exercise the presence guard;
undo and save afterward. `WickerOutletControllerTest` checks the rendered
binding and that the counter is outside the sender's scope. Remaining outlet
and AssetMapper scope is tracked in `docs/sprint-stimulus-assetmapper.md`.

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
package should contain only the bundle, the grammars, the language
configuration, the icon and leaf SVGs, and the three documents copied in by
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
