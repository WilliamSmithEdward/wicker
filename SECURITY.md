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
runs on pull requests, pushes to `main`, daily, on demand, and when a release
is published. It uses:

- CodeQL's `security-extended` queries for JavaScript/TypeScript and GitHub Actions.
- Semgrep Community Edition with `p/security-audit` and `p/secrets` rules.
- `npm audit` against the lockfile, including development dependencies.

The [Malware scan workflow](https://github.com/WilliamSmithEdward/wicker/actions/workflows/malware-scan.yml)
runs on the same events. Its **ClamAV** and **YARA-X** jobs scan the checkout,
its installed dependencies and the VSIX.

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

### Malware scan

Dependencies are installed with `npm ci --ignore-scripts`, so nothing they
contain has run before it is scanned. The VSIX is the one built from the
scanned commit, or on a release scan the asset attached to the release, after
checking it against the SHA-256 GitHub records for that asset. Its contents
are unpacked and scanned as well. Both engines scan the same list of files:
every file in the checkout except Git history. Empty files are listed apart,
since they hold nothing to match.

- **ClamAV** runs from the `clamav/clamav` image pinned by digest in
  [clamav/Dockerfile](.github/security/clamav/Dockerfile). `freshclam`
  updates the signatures on every run and checks each database's signature
  before using it. A run fails if the daily signatures are more than three days
  old, which means the update did not happen.
- **YARA-X** runs the [YARA Forge](https://github.com/YARAHQ/yara-forge)
  full rule set, the widest of its public collections. Both the engine release
  and the rule release are pinned by SHA-256 in
  [yara.json](.github/security/yara.json), and a download that does not match
  is refused. Rule-style warnings from the compiler are not reported, since
  they concern upstream rules; a rule that fails to compile fails the scan.

Each engine must detect the EICAR test file, assembled during the run and kept
outside the scanned files, before its clean result counts. A scanner error,
a file ClamAV did not scan, a YARA-X error or timeout, and any detection not
reviewed fail the gate.

Reviewed false positives are in
[malware-exceptions.json](.github/security/malware-exceptions.json), each
matched on the engine, rule or signature, path and the SHA-256 of the file's
contents. A changed file, such as a dependency update, needs another review.
The current six are YARA-X 1.20.0 reporting `SIGNATURE_BASE_Powershell_Case_Anomaly`
in dependency files that only mention PowerShell in ordinary casing. Compiled
on its own the rule does not match them in 1.20.0 or 1.21.0, and 1.21.0 does
not match them with the full rule set either. Remove them when YARA-X 1.21.0
or later is pinned.

The [Update YARA rules workflow](.github/workflows/update-yara-rules.yml) runs weekly. It
proposes the newest YARA Forge release, and any YARA-X release at least a week
old, as a pull request that records the digests GitHub holds for the assets,
then starts the Malware scan workflow on that branch. Merge it only when that scan
passes. Pull requests the workflow opens with its own token start no other
workflow, which is why it starts the scan itself.

### Updates

Dependabot checks npm development tools, GitHub Actions and the ClamAV and
Semgrep images weekly, and adopts a release once it is a week old. Actions
are pinned to full commit SHAs, the runner to `ubuntu-24.04`, and Node to an
exact version. Semgrep runs from its official image, pinned by digest in
[.github/security/semgrep/Dockerfile](.github/security/semgrep/Dockerfile).

GitHub's Dependabot security updates are enabled. Dependency updates still need
review and passing CI; they are not automatically merged. Wicker continues to
ship no third-party runtime code.

The test CLI currently requests Mocha 11, whose dependencies include vulnerable
versions of `diff` and `serialize-javascript`. A scoped npm override uses Mocha
12.0.2 or newer in that CLI, matching the major version already used directly
by the integration tests. Remove the override when the CLI updates its own
dependency. Verify changes to it with the real VS Code integration suite.

## Reports for future releases

New releases receive `security-report.md`, `security-report.json`, and
`security-results.tar.gz` from the Security workflow, and `malware-report.md`,
`malware-report.json` and `malware-results.tar.gz` from the Malware scan
workflow, each tarball containing the raw scanner results. Reports identify
the exact scanned commit, workflow run, tool versions where reported, finding
counts, failures, and SHA-256 digests of the raw results. Failed analysis produces
a **FAIL** report rather than claiming the release is clean. Existing releases
are not backfilled.

For a pre-publication check:

1. Push the release commit and its `vX.Y.Z` tag, then create a **draft** GitHub
   release with the same title and attach the VSIX.
2. Run the Security and Malware scan workflows on `main`, setting
   `release_tag` to that tag:
   `gh workflow run security.yml --ref main -f release_tag=vX.Y.Z` and
   `gh workflow run malware-scan.yml --ref main -f release_tag=vX.Y.Z`. `main`
   must be at the release commit: the ClamAV and YARA-X jobs build nothing from
   a ref they did not check out themselves, and stop if the two differ.
3. Wait for both runs to succeed, including **Security passed**, **Malware scan
   passed** and each **Attach release report**. Check that the reports name the
   intended tag and commit. Publish the draft only after both the report and normal release
   checks pass, then publish that same VSIX to the Marketplace.

Publication triggers another scan and refreshes the same report assets. A
post-publication failure fails the workflow and attaches a failing report; it
cannot undo a release or Marketplace publication. GitHub's manual publishing
controls do not enforce the draft procedure. Do not move a tag after scanning.

The reports cover source, locked dependencies and the VSIX attached to the
release. They are evidence of the checks performed, not a certification that no
vulnerability or malware exists. Missing reports mean analysis has not completed
successfully.

To enforce the merge gate in repository rules, require the **CI passed**,
**Security passed** and **Malware scan passed** checks. Workflow files alone do not prevent a maintainer from
merging or publishing manually.

## Maintainer references

- [GitHub CodeQL action](https://github.com/github/codeql-action)
- [Semgrep CLI flags and exit codes](https://semgrep.dev/docs/cli-reference)
- [Dependabot configuration](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)
- [YARA-X command line](https://virustotal.github.io/yara-x/docs/cli/commands/)
- [YARA Forge releases](https://github.com/YARAHQ/yara-forge/releases)
- [ClamAV Docker images](https://docs.clamav.net/manual/Installing/Docker.html)
