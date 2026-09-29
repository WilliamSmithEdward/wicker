# Security

## Report a vulnerability privately

Use [Report a vulnerability](https://github.com/WilliamSmithEdward/wicker/security/advisories/new)
to send a private report to the maintainer. Please include the affected Wicker
version, reproduction steps, the impact you observed, and a minimal example
with credentials and personal data removed. Do not disclose an unpatched
vulnerability in a public issue.

Security fixes target the latest published version. Older versions do not have
a separate maintenance branch; update to the latest release when a fix ships.

## Automated analysis

The [Security workflow](https://github.com/WilliamSmithEdward/wicker/actions/workflows/security.yml)
runs on pull requests, pushes to `main`, weekly, on demand, and when a release
is published. It uses:

- CodeQL's `security-extended` queries for JavaScript/TypeScript and GitHub Actions.
- Semgrep Community Edition with `p/security-audit` and `p/secrets` rules.
- `npm audit` against the lockfile, including development dependencies.

The dependency audit receives only the lockfile in an isolated job, without a
source checkout, repository npm configuration, lifecycle scripts or caches.

Every unexpected finding fails the gate, regardless of severity. Scanner errors and
warnings, skipped scanner jobs, and missing or malformed reports also fail.
There is no broad baseline. The two reviewed false positives in
[semgrep-exceptions.json](.github/security/semgrep-exceptions.json) match the exact
rule, location and SHA-256 hash of each fixture's contents (with LF line endings).
They cover Symfony's documented `ComponentAttributes` output in the Alert and
Badge templates. Any changed fixture requires another review; a finding at
another location or from another rule still fails. Reports list these reviews,
retain the unmodified scanner output, and mark only these findings as accepted
in the SARIF uploaded to GitHub. Semgrep inline `nosemgrep` comments remain
disabled. Investigate failures and fix their cause;
do not make the check optional or silently exclude a finding to obtain a pass.

Tests and fixtures remain in scope. Generated files, installed dependencies
and downloaded editor builds are excluded from source scanning. Semgrep rules
and npm advisories are fetched at scan time, so a later scan can identify new
problems in unchanged code. Semgrep runs without an account or uploaded source,
and usage metrics are disabled. GitHub stores SARIF results in the repository's
[code scanning view](https://github.com/WilliamSmithEdward/wicker/security/code-scanning)
for branch and pull request scans. Release scans retain their results as assets.

Dependabot checks npm development tools, GitHub Actions and the Semgrep version
weekly. GitHub's Dependabot security updates are enabled. Dependency updates
still need review and passing CI; they are not automatically merged. Wicker
continues to ship no third-party runtime code.

The test CLI currently requests Mocha 11, whose dependencies include vulnerable
versions of `diff` and `serialize-javascript`. A scoped npm override uses Mocha
12.0.2 or newer in that CLI, matching the major version already used directly
by the integration tests. Remove the override when the CLI updates its own
dependency. Verify changes to it with the real VS Code integration suite.

## Reports for future releases

New releases receive `security-report.md`, `security-report.json`, and
`security-results.tar.gz` containing the raw scanner results. Reports identify
the exact scanned commit, workflow run, tool versions where reported, finding
counts, failures, and SHA-256 digests of the raw results. Failed analysis produces
a **FAIL** report rather than claiming the release is clean. Existing releases
are not backfilled.

For a pre-publication check:

1. Push the release commit and its `vX.Y.Z` tag, then create a **draft** GitHub
   release with the same title and attach the VSIX.
2. Run the Security workflow on `main`, setting `release_tag` to that tag:
   `gh workflow run security.yml --ref main -f release_tag=vX.Y.Z`.
3. Wait for the whole run to succeed, including **Security gate** and
   **Attach release report**. Check that the report names the intended tag and
   commit. Publish the draft only after both the report and normal release
   checks pass, then publish that same VSIX to the Marketplace.

Publication triggers another scan and refreshes the same report assets. A
post-publication failure fails the workflow and attaches a failing report; it
cannot undo a release or Marketplace publication. GitHub's manual publishing
controls do not enforce the draft procedure. Do not move a tag after scanning.

The reports analyze source and locked dependencies, not the VSIX binary. They
are evidence of the checks performed, not a certification that no vulnerability
exists. Missing reports mean analysis has not completed successfully.

To enforce the merge gate in repository rules, require the **Security gate**
check alongside CI. Workflow files alone do not prevent a maintainer from
merging or publishing manually.

## Maintainer references

- [GitHub CodeQL action](https://github.com/github/codeql-action)
- [Semgrep CLI flags and exit codes](https://semgrep.dev/docs/cli-reference)
- [Dependabot configuration](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)
