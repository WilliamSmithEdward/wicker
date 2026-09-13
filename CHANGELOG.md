# Changelog

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
