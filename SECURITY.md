# Security policy

## Reporting a vulnerability

Report a vulnerability privately, not in a public issue or pull request:
[open a private report](https://github.com/WilliamSmithEdward/wicker/security/advisories/new).
Only the maintainer sees it. Include the Wicker version, the VS Code version
and the impact you observed, and the smallest file or steps that show it,
with credentials and private data removed.

A confirmed vulnerability is fixed in a release on the Visual Studio
Marketplace, and the advisory is published with it,
crediting you unless you ask otherwise.

## Supported versions

Only the latest release on the Visual Studio Marketplace receives security
fixes. Older releases are not maintained separately; update when a fix ships.

## Scope

Wicker reads the Symfony projects in the workspace: PHP, Twig, YAML, JSON and
import-map files. Its lexers and readers treat that text as input they do not
control. It makes no network requests of its own and ships no third-party
runtime code. It changes a file only through an edit you choose, such as a
code action, and keeps the console's last answers in VS Code's workspace
state.

A way for a project's files, or the console's output, to make Wicker run a
command, write a file or show active content is a vulnerability here.

### The Symfony console

Wicker asks the project's own console for namespaces, routes, components and
Twig callables, with Symfony's `debug:` commands. It runs `php bin/console`
from the project root, or the command set in `wicker.console.command`. The
command runs directly, not through a shell, with a time limit, and its output
is parsed as untrusted input.

The console never runs in an untrusted workspace, because the command can
come from workspace settings. Set `wicker.console.enabled` to `false` to turn
it off everywhere; Wicker then reads configuration files only.

## How the code is checked

Three workflows check every pull request and every push to `main`, and
their gates decide whether a change can merge: **CI passed**,
**Security passed** and **Malware scan passed**. A gate passes only when
every job before it did, and any unexpected finding fails it, whatever its
severity. Security and Malware scan also run daily, in every release, and
by hand. A scanner error or warning, a skipped scanner job, and a missing
or malformed report fail the gate too.

- **Code:** CodeQL with the `security-extended` queries, for
  JavaScript/TypeScript and GitHub Actions, and Semgrep Community Edition with
  `p/security-audit` and `p/secrets`. Semgrep runs with inline `nosemgrep`
  comments disabled and usage metrics off. Tests and fixtures are scanned;
  generated output, installed dependencies and downloaded editor builds are
  not. Results go to the repository's code scanning; a release scan keeps its
  results with the release instead.
- **Workflows:** zizmor audits the GitHub Actions workflows; a finding fails
  Security.
- **Dependencies:** `npm audit` over the lockfile, development tools
  included. The audit job receives only the lockfile: no source checkout,
  npm configuration, lifecycle scripts or caches.
- **Malware:** ClamAV, with signatures freshclam fetches and verifies on
  every run, and YARA-X, with the YARA Forge rules pinned to a release and
  its SHA-256, scan every file in the checkout except Git history, the
  dependencies `npm ci --ignore-scripts` installs, and the VSIX, packed and
  unpacked. The VSIX is built once from the scanned commit, and in a release
  it is the file the release ships. YARA-X uses the YARA Forge full
  rule set. Each engine must detect the EICAR test file, assembled during the
  run, before its clean result counts, and a ClamAV run fails if the daily
  signatures are more than three days old.
- **Fuzzing:** fast-check properties in
  `packages/core/src/parsers.properties.test.ts` generate input for the
  readers that take text Wicker does not control: the PHP and Twig lexers,
  template references and names, the Stimulus action reader, and the YAML,
  JSON, `composer.json`, `twig.yaml` and import-map readers. Each must not
  throw, must keep its offsets inside the text, and where it promises to,
  must split the text exactly. The unit tests run each property a hundred
  times. The Fuzz workflow runs on every change to `packages/core/src` and
  daily, twenty thousand times per property on a change and two hundred
  thousand daily. It is not a gate: a finding becomes a regression test with
  its fix.
- **OpenSSF Scorecard** rates the repository's security practices on every
  change to `main` and weekly, and the README badge shows the result.
  One of its checks does not fit this project: a single maintainer cannot
  have a second person approve every change. Signed-Releases rises as
  releases carry the provenance bundle; it counts the last five.

## Accepted findings

A finding is fixed, or accepted with a written reason in
[semgrep-exceptions.json](.github/security/semgrep-exceptions.json) or
[malware-exceptions.json](.github/security/malware-exceptions.json). An
entry matches the tool, the rule or signature, the path (for Semgrep, the
exact location too) and the file's SHA-256 (for Semgrep, of its contents
with LF line endings), so a changed file needs another review. An entry that
no longer matches any finding fails the report, so remove it in the change
that makes it stale.
CodeQL and `npm audit` have no accepted list: every result fails. zizmor
keeps its exceptions in `.github/zizmor.yml` or inline beside the line they
excuse, each with its reason; there are none.

The report lists each accepted finding, keeps the scanner's unmodified
output, and marks only those findings as accepted in the SARIF uploaded to
GitHub. The current entries:

- Two Semgrep findings of
  `generic.html-templates.security.unquoted-attribute-var` in the Alert and
  Badge test fixtures, which use Symfony's documented `ComponentAttributes`
  output. The fixtures are not shipped in the extension.
- Six YARA-X matches of `SIGNATURE_BASE_Powershell_Case_Anomaly` in
  dependency files that only mention PowerShell in ordinary casing. Only
  YARA-X 1.20.0 with the full rule set reports them; 1.21.0 does not. Remove
  them when YARA-X 1.21.0 or later is pinned.

## Pinning and updates

Everything the workflows run is pinned: actions to full commit SHAs,
runners to named OS releases, scanner images to digests, Python tools to
hash-locked lock files, the project's own dependencies to the npm lockfile
installed with `npm ci`, Node to an exact version, and the YARA-X engine and
YARA Forge rules to a release and its SHA-256. ClamAV's signatures change too
often to pin, so freshclam fetches and verifies them on every run. Semgrep's
registry rules and npm's advisories are also fetched at scan time, so a later
scan can find new problems in unchanged code.

Dependabot proposes updates to npm, GitHub Actions, the ClamAV and Semgrep
images, and the hash-locked zizmor requirements once a version is a week
old, and at once for a security advisory. The Update YARA rules workflow
proposes new YARA pins each week. A minor or patch update, and the YARA
pull request, merges itself once CI, Security and Malware scan pass; a
third-party major version waits for review.

The VS Code test CLI requests Mocha 11, whose dependencies include
vulnerable versions of `diff` and `serialize-javascript`. A scoped npm
override gives that CLI Mocha 12.0.2 or newer, the major version the
integration tests already use directly. Remove the override when the CLI
updates its own dependency, and verify any change to it with the real VS
Code integration suite.

## Releases

Pushing a `vX.Y.Z` tag runs the Publish workflow. It builds the VSIX from
the tagged commit in CI, refusing a tag that is not the extension's version,
runs Security and Malware scan on that commit and that VSIX, and only when
both pass signs the VSIX's build provenance and creates the GitHub release
with:

- `wicker-<version>.vsix`, the file published to the Marketplace
- `wicker-<version>.sigstore.json`, its signed build provenance
- `security-report.md`, `security-report.json` and `security-results.tar.gz`
- `malware-report.md`, `malware-report.json` and `malware-results.tar.gz`

Each tarball holds the raw scanner results. A report names the scanned
commit, the workflow run, tool versions where reported, finding counts,
failures, and the SHA-256 digests of the raw results. A failed scan fails
Publish before anything is signed or released. Started by hand, Publish is
a dry run: it builds, scans and assembles the same files as the
`release-preview` artifact and releases nothing.

To check that a VSIX was built by this repository's Publish workflow from a
tagged commit:

```bash
gh attestation verify wicker-<version>.vsix --repo WilliamSmithEdward/wicker
```

The Marketplace upload is by hand, of the VSIX on the release. Releases up to
0.12.1 were built locally and carry no provenance, and releases before these
workflows carry no reports.

The reports cover the source, the locked dependencies and the VSIX the
release carries. They record the checks performed; they are not a
certification that no vulnerability or malware exists.

### Maintainer references

- [GitHub CodeQL action](https://github.com/github/codeql-action)
- [Semgrep CLI flags and exit codes](https://semgrep.dev/docs/cli-reference)
- [Dependabot configuration](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)
- [YARA-X command line](https://virustotal.github.io/yara-x/docs/cli/commands/)
- [YARA Forge releases](https://github.com/YARAHQ/yara-forge/releases)
- [ClamAV Docker images](https://docs.clamav.net/manual/Installing/Docker.html)

## Repository settings

<!-- repo-standards:begin security-settings. Copied from WilliamSmithEdward/repo-standards, templates/security/settings-block.md. Change it there; the weekly rescan fails a copy that differs. -->
- `main` accepts changes only through a pull request that passes
  **CI passed**, **Security passed** and **Malware scan passed**. The
  ruleset has no bypass, for the owner either, and refuses force-pushes and
  deleting the branch.
- A `v*` release tag cannot be moved or deleted once pushed, except by a
  repository admin.
- A workflow that uses an action not pinned to a full commit SHA fails to
  run. Workflow tokens are read-only unless a job is granted more for
  itself.
- Secret scanning with push protection, Dependabot alerts and security
  updates, and private vulnerability reporting are on.
<!-- repo-standards:end -->
