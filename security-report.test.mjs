import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createReport, inspectSarif, reviewSemgrepFindings } from './security-report.mjs';

const environment = {
  SCAN_SHA: 'a'.repeat(40),
  SCAN_JOBS: JSON.stringify(Object.fromEntries(
    ['revision', 'codeql', 'semgrep', 'dependencies'].map(name => [name, { result: 'success' }]),
  )),
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'example/repository',
  GITHUB_RUN_ID: '123',
};

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'wicker-security-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sarif = {
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'scanner', version: '1' } }, results: [], invocations: [{ executionSuccessful: true }] }],
  };
  const write = (path, data) => writeFileSync(join(directory, path), JSON.stringify(data));
  for (const name of ['codeql-javascript-typescript', 'codeql-actions', 'semgrep', 'dependencies']) {
    mkdirSync(join(directory, name));
    if (name !== 'dependencies') write(`${name}/${name === 'semgrep' ? 'semgrep' : 'results'}.sarif`, sarif);
  }
  write('semgrep/semgrep.json', { results: [], errors: [], paths: { scanned: ['source.ts'] } });
  write('dependencies/npm-audit.json', { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } });
  return { directory, sarif, write };
}

test('passing evidence records the scanned commit and digests of every raw report', t => {
  const { directory } = fixture(t);
  const report = createReport(directory, environment);
  assert.equal(report.status, 'PASS');
  assert.equal(report.commit, environment.SCAN_SHA);
  assert.equal(report.evidence.length, 5);
  assert.ok(report.evidence.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
});

test('even a suppressed note-level finding fails', t => {
  const { directory, sarif, write } = fixture(t);
  sarif.runs[0].results.push({ level: 'note', suppressions: [{ status: 'accepted' }] });
  write('codeql-actions/results.sarif', sarif);
  assert.equal(createReport(directory, environment).status, 'FAIL');
});

for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
  test(`a ${result ?? 'missing'} scanner job cannot pass on clean output`, t => {
    const { directory } = fixture(t);
    const jobs = JSON.parse(environment.SCAN_JOBS);
    jobs.semgrep = { result };
    assert.equal(createReport(directory, { ...environment, SCAN_JOBS: JSON.stringify(jobs) }).status, 'FAIL');
  });
}

test('scanner warnings and unsuccessful invocations fail', t => {
  const { directory, sarif, write } = fixture(t);
  sarif.runs[0].invocations[0].toolExecutionNotifications = [{ level: 'warning' }];
  write('codeql-actions/results.sarif', sarif);
  assert.throws(() => inspectSarif(join(directory, 'codeql-actions')), /warning or error/);
  sarif.runs[0].invocations = [{ executionSuccessful: false }];
  write('codeql-actions/results.sarif', sarif);
  assert.throws(() => inspectSarif(join(directory, 'codeql-actions')), /did not succeed/);
});

test('missing or malformed reports still produce a failing release summary', t => {
  const { directory } = fixture(t);
  rmSync(join(directory, 'codeql-actions/results.sarif'));
  writeFileSync(join(directory, 'semgrep/semgrep.json'), '{broken');
  const report = createReport(directory, environment);
  assert.equal(report.status, 'FAIL');
  assert.equal(report.scanners.filter(scanner => scanner.error).length, 2);
  assert.match(readFileSync(join(directory, 'security-report.md'), 'utf8'), /\*\*FAIL\*\*/);
});

test('empty scans, Semgrep errors and invalid audit evidence fail', t => {
  const { directory, write } = fixture(t);
  write('semgrep/semgrep.json', { results: [], errors: [], paths: { scanned: [] } });
  assert.equal(createReport(directory, environment).status, 'FAIL');
  write('semgrep/semgrep.json', { results: [], errors: [{ type: 'ParseError' }], paths: { scanned: ['source.ts'] } });
  write('dependencies/npm-audit.json', { error: { message: 'registry unavailable' } });
  const report = createReport(directory, environment);
  assert.equal(report.scanners.filter(scanner => scanner.error).length, 2);
});

test('dependency advisories of any severity and absent commit identity fail', t => {
  const { directory, write } = fixture(t);
  write('dependencies/npm-audit.json', {
    auditReportVersion: 2, vulnerabilities: { example: { severity: 'low' } }, metadata: { vulnerabilities: { total: 1 } },
  });
  assert.equal(createReport(directory, environment).status, 'FAIL');
  assert.ok(createReport(directory, { ...environment, SCAN_SHA: '' }).problems.includes('Missing or invalid scanned commit'));
});

function reviewedFixture(t) {
  const { directory } = fixture(t);
  const source = '<div {{ attributes }}></div>\n';
  writeFileSync(join(directory, 'component.twig'), source);
  const finding = { check_id: 'unquoted-attribute', path: 'component.twig', start: { line: 1, col: 6 }, end: { line: 1, col: 22 } };
  const exception = {
    rule: finding.check_id, path: finding.path, start: finding.start, end: finding.end,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    reason: 'A reviewed framework attribute bag.', reference: 'https://example.com/component-attributes',
  };
  return { directory, source, finding, exception };
}

test('review applies only to the exact rule, location and fixture, preserving other findings', t => {
  const { directory, finding, exception } = reviewedFixture(t);
  const unexpected = [
    { ...finding, check_id: 'another-rule' },
    { ...finding, path: 'another.twig' },
    { ...finding, start: { line: 2, col: 6 } },
    { ...finding, end: { line: 1, col: 23 } },
  ];
  const reviews = reviewSemgrepFindings([finding, ...unexpected], [exception], directory);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].reason, exception.reason);
  assert.equal(reviewSemgrepFindings(unexpected, [exception], directory).length, 0);
});

test('changed fixture content invalidates review even when the finding stays in place', t => {
  const { directory, source, finding, exception } = reviewedFixture(t);
  writeFileSync(join(directory, finding.path), `${source}<script>unexpected()</script>\n`);
  assert.throws(() => reviewSemgrepFindings([finding], [exception], directory), /Reviewed fixture changed/);
});

test('Windows line endings preserve review identity, but missing rationale fails', t => {
  const { directory, source, finding, exception } = reviewedFixture(t);
  writeFileSync(join(directory, finding.path), source.replaceAll('\n', '\r\n'));
  assert.equal(reviewSemgrepFindings([finding], [exception], directory).length, 1);
  assert.throws(() => reviewSemgrepFindings([finding], [{ ...exception, reason: '' }], directory), /reason and reference/);
});
