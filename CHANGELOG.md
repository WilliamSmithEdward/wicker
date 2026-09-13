# Changelog

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
