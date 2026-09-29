// CI tooling only. Findings, scanner failures and missing evidence all fail closed.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    requireEvidence(!entry.isSymbolicLink(), `Unexpected symbolic link: ${path}`);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}

export function inspectSarif(directory) {
  const files = filesIn(directory).filter(path => path.endsWith('.sarif'));
  requireEvidence(files.length > 0, 'Missing SARIF output');
  let findings = 0;
  const tools = [];
  for (const file of files) {
    const data = readJson(file);
    requireEvidence(data.version === '2.1.0' && Array.isArray(data.runs) && data.runs.length > 0,
      'Invalid or empty SARIF runs');
    for (const run of data.runs) {
      requireEvidence(typeof run.tool?.driver?.name === 'string' && Array.isArray(run.results),
        'Missing SARIF tool or results');
      for (const invocation of run.invocations ?? []) {
        requireEvidence(invocation.executionSuccessful === true, 'Scanner invocation did not succeed');
        for (const notification of [
          ...(invocation.toolExecutionNotifications ?? []),
          ...(invocation.toolConfigurationNotifications ?? []),
        ]) {
          requireEvidence(notification.level === 'note' || notification.level === 'none',
            'Scanner reported a warning or error');
        }
      }
      // No severity threshold, suppression or baseline silently accepts a finding.
      findings += run.results.length;
      tools.push({ name: run.tool.driver.name, version: run.tool.driver.semanticVersion ?? run.tool.driver.version ?? 'not reported' });
    }
  }
  return { findings, tools };
}

function findingKey(rule, path, start, end) {
  return JSON.stringify([rule, path, start.line, start.col, end.line, end.col]);
}

export function reviewSemgrepFindings(findings, exceptions, root = process.cwd()) {
  requireEvidence(Array.isArray(exceptions), 'Invalid Semgrep exceptions');
  const reviewed = [];
  for (const finding of findings) {
    const key = findingKey(finding.check_id, finding.path, finding.start, finding.end);
    const exception = exceptions.find(entry => findingKey(entry.rule, entry.path, entry.start, entry.end) === key);
    if (!exception) continue;
    const path = resolve(root, finding.path);
    requireEvidence(!isAbsolute(finding.path) && !relative(root, path).startsWith('..') && path !== resolve(root),
      'Exception path must be inside the repository');
    // Git normalizes line endings; a Windows checkout must have the same identity.
    const source = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
    const digest = createHash('sha256').update(source).digest('hex');
    requireEvidence(digest === exception.sourceSha256, `Reviewed fixture changed: ${finding.path}`);
    requireEvidence(typeof exception.reason === 'string' && exception.reason.length > 0
      && typeof exception.reference === 'string' && exception.reference.length > 0, 'Exception requires a reason and reference');
    reviewed.push({ key, rule: finding.check_id, path: finding.path, sourceSha256: digest,
      reason: exception.reason, reference: exception.reference });
  }
  return reviewed;
}

function inspectSemgrep(directory, writeReviewedSarif = false) {
  const sarif = inspectSarif(directory);
  const data = readJson(join(directory, 'semgrep.json'));
  requireEvidence(Array.isArray(data.errors) && data.errors.length === 0, 'Semgrep reported scanner errors');
  requireEvidence(Array.isArray(data.results) && data.results.length === sarif.findings,
    'Semgrep JSON and SARIF results disagree');
  requireEvidence(Array.isArray(data.paths?.scanned) && data.paths.scanned.length > 0,
    'Semgrep did not scan any files');
  const reviewed = reviewSemgrepFindings(data.results, readJson('.github/security/semgrep-exceptions.json'));
  if (writeReviewedSarif) {
    const upload = readJson(join(directory, 'semgrep.sarif'));
    const keys = new Set(data.results.map(finding => findingKey(finding.check_id, finding.path, finding.start, finding.end)));
    for (const run of upload.runs) {
      for (const result of run.results) {
        const location = result.locations?.[0]?.physicalLocation;
        const region = location?.region;
        requireEvidence(region && location.artifactLocation?.uri, 'Missing Semgrep SARIF location');
        const key = findingKey(result.ruleId, location.artifactLocation.uri,
          { line: region.startLine, col: region.startColumn }, { line: region.endLine, col: region.endColumn });
        requireEvidence(keys.delete(key), 'Semgrep JSON and SARIF locations disagree');
        const exception = reviewed.find(entry => entry.key === key);
        if (exception) {
          result.suppressions = [{ kind: 'external', status: 'accepted', justification: `${exception.reason} ${exception.reference}` }];
        }
      }
    }
    requireEvidence(keys.size === 0, 'Missing Semgrep SARIF findings');
    // Keep the raw evidence intact; only the GitHub upload records review status.
    const uploadDirectory = join(directory, '..', 'semgrep-reviewed');
    mkdirSync(uploadDirectory, { recursive: true });
    writeFileSync(join(uploadDirectory, 'semgrep.sarif'), `${JSON.stringify(upload, null, 2)}\n`);
  }
  return { ...sarif, findings: sarif.findings - reviewed.length, reviewed, scannedFiles: data.paths.scanned.length };
}

function inspectAudit(directory) {
  const data = readJson(join(directory, 'npm-audit.json'));
  const findings = data.metadata?.vulnerabilities?.total;
  requireEvidence(!data.error && data.auditReportVersion === 2 && Number.isInteger(findings) && findings >= 0
    && data.vulnerabilities && typeof data.vulnerabilities === 'object', 'Missing or invalid npm audit evidence');
  requireEvidence(Object.keys(data.vulnerabilities).length === findings, 'Inconsistent npm vulnerability count');
  return { findings, tools: [{ name: 'npm audit', version: 'Node 22 bundled npm' }] };
}

export function createReport(directory, environment) {
  mkdirSync(directory, { recursive: true });
  const problems = [];
  let jobs = {};
  try {
    jobs = JSON.parse(environment.SCAN_JOBS ?? '{}');
    for (const name of ['revision', 'codeql', 'semgrep', 'dependencies']) {
      requireEvidence(jobs[name]?.result === 'success', `${name} job: ${jobs[name]?.result ?? 'missing'}`);
    }
  } catch (error) {
    problems.push(error.message);
  }
  const sha = environment.SCAN_SHA ?? '';
  if (!/^[a-f0-9]{40}$/.test(sha)) problems.push('Missing or invalid scanned commit');

  const scanners = [
    ['CodeQL JavaScript/TypeScript', 'codeql-javascript-typescript', inspectSarif],
    ['CodeQL GitHub Actions', 'codeql-actions', inspectSarif],
    ['Semgrep', 'semgrep', inspectSemgrep],
    ['npm audit (including development tools)', 'dependencies', inspectAudit],
  ].map(([name, folder, inspect]) => {
    try {
      const result = inspect(join(directory, folder));
      if (result.findings > 0) problems.push(`${name}: ${result.findings} finding(s)`);
      return { name, ...result };
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
      return { name, findings: null, error: error.message };
    }
  });

  const evidence = filesIn(directory)
    .filter(path => !['security-report.md', 'security-report.json'].includes(relative(directory, path)))
    .map(path => ({
      path: relative(directory, path).replaceAll('\\', '/'),
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    }));
  const report = {
    status: problems.length === 0 ? 'PASS' : 'FAIL',
    commit: sha,
    tag: environment.RELEASE_TAG || null,
    generatedAt: new Date().toISOString(),
    run: `${environment.GITHUB_SERVER_URL}/${environment.GITHUB_REPOSITORY}/actions/runs/${environment.GITHUB_RUN_ID}`,
    jobs,
    scanners,
    problems,
    evidence,
  };
  const markdown = [
    '# Wicker security report', '',
    `Result: **${report.status}**`, '',
    `Commit: \`${sha}\``, '',
    `Release: ${report.tag ?? 'not a release scan'}`, '',
    `Generated: ${report.generatedAt}`, '',
    `[Workflow run](${report.run})`, '',
    '| Analysis | Unexpected findings | Reviewed false positives |', '| --- | --- | --- |',
    ...scanners.map(scanner => `| ${scanner.name} | ${scanner.findings ?? 'Unavailable (failed)'} | ${scanner.reviewed?.length ?? 0} |`), '',
    ...problems.map(problem => `- ${problem.replaceAll('\n', ' ')}`), '',
    ...scanners.flatMap(scanner => (scanner.reviewed ?? []).map(entry => `- Reviewed false positive in \`${entry.path}\`: ${entry.reason} [Reference](${entry.reference})`)), '',
    'Policy: every unexpected finding fails, regardless of severity. The only exceptions are the exact reviewed findings listed above, matched against fixture content hashes. Scanner failures, warnings, skipped jobs and missing or malformed evidence fail the gate.', '',
    'Scope: CodeQL security-extended for JavaScript/TypeScript and GitHub Actions; Semgrep Community Edition p/security-audit and p/secrets; npm lockfile audit including development tools. Semgrep registry rules and vulnerability advisories are fetched at scan time. Generated output and dependencies are excluded from source scanning.', '',
    'Raw results and their SHA-256 digests accompany this report. This is a source and dependency scan of the named commit, not an audit or a certification of the VSIX binary. A passing scan does not prove the absence of vulnerabilities.', '',
  ].join('\n');
  writeFileSync(join(directory, 'security-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(directory, 'security-report.md'), markdown);
  if (environment.GITHUB_STEP_SUMMARY) appendFileSync(environment.GITHUB_STEP_SUMMARY, markdown);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [, , command, directory] = process.argv;
    requireEvidence(directory, 'Usage: node security-report.mjs <sarif|semgrep|report> <directory>');
    if (command === 'sarif') {
      const { findings } = inspectSarif(directory);
      requireEvidence(findings === 0, `${findings} security finding(s)`);
    } else if (command === 'semgrep') {
      const { findings, reviewed } = inspectSemgrep(directory, true);
      console.log(`Semgrep: ${findings} unexpected finding(s), ${reviewed.length} reviewed false positive(s)`);
      requireEvidence(findings === 0, `${findings} unexpected Semgrep finding(s)`);
    } else if (command === 'report') {
      const report = createReport(directory, process.env);
      console.log(`Security gate: ${report.status}`);
      process.exitCode = report.status === 'PASS' ? 0 : 1;
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
