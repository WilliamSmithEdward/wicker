# Changelog

## 0.5.0

Stimulus and AssetMapper, and the connections between them.

### Added

- **AssetMapper.** Configured roots, namespaces and exclusions read from the
  console and the asset map walked from them. `asset()` completes logical paths
  and opens the file behind one; `importmap()` completes entrypoints only.
- **Import specifiers** navigate in JavaScript and TypeScript, relative against
  the importing file and bare against `importmap.php`, which is where a `#`
  alias is declared. Unresolvable imports are reported, with each check
  suspended when the discovery it depends on is unavailable.
- **Stylesheets beneath a template**, found by whatever route reaches them: a
  direct `asset()` link, an importmap entrypoint, a Stimulus controller, and
  the `@import` chain of any stylesheet those lead to.
- **Stimulus CSS classes** end to end: `static classes`, the
  `data-<identifier>-<name>-class` attribute and the helper's class argument.
- **Action descriptors in full.** Events, key filters, `window` and `document`
  targets and action options all complete, not only the method.
- **Events between controllers.** `this.dispatch('changed')` is offered to a
  listener as `<identifier>:changed`, and the composed name opens the dispatch.
- **Generated members.** `statusUrlValue`, `hasBusyClass` and `outputTarget`
  complete after `this.` and lead back to the declaration they came from.
- **Value types and defaults**, shown wherever the value appears.
- **Outlets**: declarations, generated properties, callbacks, receiver methods,
  Twig bindings in every helper form, and Find All References across both.
- **Explanations in the project's own names.** A binding says which method an
  event calls and in which file. A binding that connects to nothing says which
  of the three ways it failed, since Stimulus reports none of them.
- **A quick fix that writes the missing member**, adding a method inside the
  class body or a name to its static list.
- Declared Stimulus members are coloured in JavaScript and TypeScript through a
  themeable `wicker.stimulusMember` colour.

### Fixed

- JSON endpoints appear under their controller in the sidebar. Action rows came
  from render sites alone, so an action returning JSON had no row at all while
  its route was listed under API routes.
- Route icons are decided in one place. The same route could be drawn as a
  globe in its section and a leaf under its controller, and the leaf claims a
  template is rendered.
- The Scripts group has an icon that exists. `code-block` is not a codicon, and
  `ThemeIcon` draws nothing for an unknown id without reporting a problem.

## 0.4.0

### Added

- Stimulus controller, action, target and value completion/navigation from Twig
  helpers and HTML attributes, using the project's runtime configuration and
  direct JavaScript/TypeScript declarations, including unsaved member edits.
- Route completion/navigation in Twig, fetch-to-controller/template navigation,
  Template routes and API routes in the sidebar, and Find All References for
  explicit Twig/JS consumers.
- JSON response field completion and declaration navigation in JavaScript and
  inline Twig scripts, following local awaited fetch/json assignments, literal
  PHP response arrays and Twig-supplied Stimulus URL values.
- Controller action rows show their HTTP method and URL first, keeping the PHP
  method name as secondary detail. Without route discovery, template targets
  provide context beside the method name.
- Distinct icons for each tree object type. Twig templates use a leaf, Twig
  routes use a leaf with a route arrow, and JSON routes use the object icon.
- Route rows sort by URL path in both route sections and under controllers.
- Controller dependencies link directly to project services, repositories,
  entities and other declared types, following unsaved source edits.
- Associated scripts beneath Twig templates and controllers, connected through
  Stimulus bindings, literal template relationships and route consumers. Local
  source maps let the tree prefer TypeScript over its generated JavaScript.

## 0.3.0

### Added

- Twig Component name completion, hover and navigation from HTML-like tags,
  `component()` and component tags, using Symfony's registered class/template
  pairs. Prop completion and navigation cover direct PHP properties, setters,
  mount parameters and anonymous `{% props %}`, including unsaved source edits.
- Twig local-variable completion and hover for assignments, loop bindings,
  macro parameters and literal `with` scopes. Literal includes and inheritance
  carry context across files, respecting `only`, overrides and project boundaries.
  Hover identifies possible PHP/Twig sources. Follows unsaved edits and file
  changes without adding unknown-variable diagnostics.
- Twig filter and function completion using the project's `debug:twig` output,
  including custom registrations. Hover shows discovered metadata and official
  references for standard names. Wildcard registrations resolve without being
  inserted as literal callable names.
- Unknown Twig filter/function warnings when discovery is fresh and complete,
  configurable through `wicker.diagnostics.unknownCallable`. Application PHP,
  configuration and dependency changes refresh discovery automatically. Warnings
  are suspended for unsaved project changes or unavailable/incomplete discovery.

### Fixed

- Rebuild again when a project change arrives during an in-flight refresh,
  preventing older discovery results from overwriting newer project state.

## 0.2.0

### Added

- Controllers and Templates sections in the Wicker sidebar. Expand controller
  actions to browse literal render targets, jump to PHP calls or attributes,
  and open their Twig files. Follows unsaved edits and shows unresolved targets.
- Twig variable completion and hover from literal controller context keys.
  Hover identifies each PHP source and explains when only some render calls
  supply a variable. Follows unsaved edits, respects local bindings and
  `wicker.enable`, and keeps nested workspace contexts separate.
- Wicker sidebar with a monochrome leaf Activity Bar icon. Browse templates by
  project, namespace and folder, see the namespace source, reveal the current template,
  refresh the index, and open Wicker settings. Includes empty and disabled states.
  Bundle namespaces are hidden by default, with a workspace-persistent toggle
  to show them. Application templates and overrides remain visible.
- "Rendered by" links above Twig templates jump to each PHP render call or
  `#[Template]` attribute that resolves to the file. Links follow unsaved PHP
  edits, file creation, changes, renames and deletion, and template overrides.
  They respect `wicker.enable` and VS Code's `editor.codeLens` setting.

### Removed

- Persistent Wicker status bar item. Namespace status and project details are
  available from the Wicker sidebar.

### Changed

- Hide minimap region headings in Twig by default. Folding markers for ordinary
  Twig blocks were producing oversized labels containing raw template syntax.
- Moved namespace source information into the project tooltip. Limited
  resolution shows a warning with Retry and Settings actions. The project
  context menu's Show diagnostics action opens a report for that project;
  normal tree rows no longer open Output.

## 0.1.1

### Fixed

- `wicker.enable` now works. It was declared in the settings but read by
  nothing, so turning Wicker off left every feature running. Setting it to
  false now silences navigation, hover, completion, colouring, quick fixes and
  diagnostics together, and hides the status bar item.

### Changed

- General PHP language support is no longer on the roadmap. VS Code selects a
  single provider for completion and for semantic tokens, so competing there
  with an established PHP extension either replaces a mature implementation or
  ships features that silently never run. Wicker stays on Symfony and Twig and
  expects to sit alongside a PHP extension.

## 0.1.0

First release. The bridge between a Symfony controller and the Twig template it
renders.

### Added

- **Go to definition** on every template name, from PHP and from Twig.
- **Hover** naming the resolved file, the kind of reference that reached it, and
  the variables the controller passes alongside.
- **Completion** of indexed template names inside the quotes.
- **Diagnostics** for a name that resolves to nothing, telling a missing file
  apart from an unregistered namespace, and staying silent on a name built at
  runtime.
- **Quick fix** creating the missing template, scaffolded and opened. It
  declines when the namespace is unregistered, since there is nowhere to put a
  file Twig could load.
- **Semantic colouring** of template names that resolve, so the references the
  extension understands are visible in the code rather than only on hover.
- **Twig syntax highlighting**, with HTML, JavaScript and CSS embedded.
- **Namespace resolution** from `bin/console debug:twig`, remembered so a
  stopped container does not lose it, falling back to
  `config/packages/twig.yaml` where no PHP is reachable at all.

References covered: `render()` and its siblings, `#[Template]`, and named
arguments in PHP; `extends`, `include`, `embed`, `use`, `import`, `from` and the
`include()` and `source()` functions in Twig.

### Notes

The extension ships no third-party runtime code. The Twig lexer, the PHP lexer
and the YAML reader were written for it.

Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=WilliamSmithE.wicker),
or from the `.vsix` attached to the release.
