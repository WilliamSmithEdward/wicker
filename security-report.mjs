// CI tooling only. Findings, scanner failures and missing evidence all fail closed.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
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

function inspectSemgrep(directory) {
  const sarif = inspectSarif(directory);
  const data = readJson(join(directory, 'semgrep.json'));
  requireEvidence(Array.isArray(data.errors) && data.errors.length === 0, 'Semgrep reported scanner errors');
  requireEvidence(Array.isArray(data.results) && data.results.length === sarif.findings,
    'Semgrep JSON and SARIF results disagree');
  requireEvidence(Array.isArray(data.paths?.scanned) && data.paths.scanned.length > 0,
    'Semgrep did not scan any files');
  return { ...sarif, scannedFiles: data.paths.scanned.length };
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
    '| Analysis | Findings |', '| --- | --- |',
    ...scanners.map(scanner => `| ${scanner.name} | ${scanner.findings ?? 'Unavailable (failed)'} |`), '',
    ...problems.map(problem => `- ${problem.replaceAll('\n', ' ')}`), '',
    'Policy: every finding fails, regardless of severity. Scanner failures, warnings, skipped jobs and missing or malformed evidence fail the gate.', '',
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
    requireEvidence(directory, 'Usage: node security-report.mjs <sarif|report> <directory>');
    if (command === 'sarif') {
      const { findings } = inspectSarif(directory);
      requireEvidence(findings === 0, `${findings} security finding(s)`);
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
