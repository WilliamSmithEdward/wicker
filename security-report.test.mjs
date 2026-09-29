import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectMalwareDetections, createReport, inspectMalware, inspectPipAudit, inspectSarif, parseClamavVersion,
  reviewMalwareDetections, reviewSemgrepFindings } from './security-report.mjs';

const environment = {
  SCAN_SHA: 'a'.repeat(40),
  SCAN_JOBS: JSON.stringify({
    ...Object.fromEntries(['revision', 'codeql', 'semgrep', 'dependencies', 'malware'].map(name => [name, { result: 'success' }])),
    'release-asset': { result: 'skipped' },
  }),
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
  write('dependencies/pip-audit.json', { dependencies: [{ name: 'semgrep', version: '1.178.0', vulns: [] }], fixes: [] });
  writeFileSync(join(directory, 'dependencies/pip-audit-exit.txt'), '0\n');
  writeMalwareEvidence(join(directory, 'malware'));
  return { directory, sarif, write };
}

/** ClamAV's version line, in the ctime form it prints: `Tue Sep  1 06:26:15 2026`. */
function clamavDate(date) {
  const [weekday, day, month, year, time] = date.toUTCString().replace(',', '').split(' ');
  return `${weekday} ${month} ${day.padStart(2, ' ')} ${time} ${year}`;
}

const EICAR_ANCHOR_YARA = '{"path":"/tmp/anchor/eicar.com","rules":[{"identifier":"BINARYALERT_Eicar_Av_Test"}]}\n';

/** Clean evidence from a scan of two files, with both engines proven on the anchor. */
function writeMalwareEvidence(directory, { signaturesAt = new Date() } = {}) {
  mkdirSync(directory, { recursive: true });
  const files = {
    'targets.txt': 'package.json\nsrc/extension.ts\n',
    'empty.txt': 'node_modules/pkg/.npmignore\n',
    'clamav-version.txt': `ClamAV 1.5.4/28138/${clamavDate(signaturesAt)}\n`,
    'clamav-anchor.log': '/anchor/eicar.com: Eicar-Test-Signature FOUND\n',
    'clamav-anchor-exit.txt': '1\n',
    'clamav.log': '\n----------- SCAN SUMMARY -----------\nKnown viruses: 3628083\nScanned files: 2\nInfected files: 0\n',
    'clamav-exit.txt': '0\n',
    'yara-version.txt': 'yara-x-cli 1.20.0\n',
    'yara-anchor.ndjson': EICAR_ANCHOR_YARA,
    'yara-anchor-exit.txt': '0\n',
    'yara.ndjson': '',
    'yara.err': '',
    'yara-exit.txt': '0\n',
    'detections.json': '[]\n',
    'yara-pins.json': readFileSync('.github/security/yara.json', 'utf8'),
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
  return directory;
}

test('passing evidence records the scanned commit and digests of every raw report', t => {
  const { directory } = fixture(t);
  const report = createReport(directory, environment);
  assert.equal(report.status, 'PASS');
  assert.equal(report.commit, environment.SCAN_SHA);
  assert.equal(report.evidence.length, 22);
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

function malwareFixture(t, options) {
  const directory = mkdtempSync(join(tmpdir(), 'wicker-malware-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return writeMalwareEvidence(directory, options);
}

test('a clean malware scan passes and names the engines and rule release', t => {
  const result = inspectMalware(malwareFixture(t));
  assert.equal(result.findings, 0);
  assert.equal(result.scannedFiles, 2);
  assert.equal(result.emptyFiles, 1);
  assert.deepEqual(result.tools.map(tool => tool.name), ['ClamAV', 'YARA-X', 'YARA Forge rules']);
  assert.match(result.tools[0].version, /^1\.5\.4, daily signatures 28138 of /);
});

/*
 * A scanner that loaded no signatures reports every file as clean. Each engine
 * has to detect the EICAR test file first, or its clean result proves nothing.
 */
test('an engine that misses the EICAR anchor fails the scan however clean the rest is', t => {
  const directory = malwareFixture(t);
  writeFileSync(join(directory, 'clamav-anchor.log'), '');
  assert.throws(() => inspectMalware(directory), /ClamAV did not detect the EICAR test file/);
  writeMalwareEvidence(directory);
  writeFileSync(join(directory, 'yara-anchor.ndjson'), '');
  assert.throws(() => inspectMalware(directory), /YARA-X did not detect the EICAR test file/);
});

test('signatures freshclam did not update, skipped files and scanner errors fail', t => {
  const stale = malwareFixture(t, { signaturesAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000) });
  assert.throws(() => inspectMalware(stale), /more than three days old/);

  const directory = malwareFixture(t);
  writeFileSync(join(directory, 'clamav.log'), 'Scanned files: 1\n');
  assert.throws(() => inspectMalware(directory), /ClamAV scanned 1 of 2 files/);
  writeMalwareEvidence(directory);
  writeFileSync(join(directory, 'clamav-exit.txt'), '2\n');
  assert.throws(() => inspectMalware(directory), /exit code 2/);
  writeMalwareEvidence(directory);
  writeFileSync(join(directory, 'yara.err'), 'error: timeout scanning src/extension.ts\n');
  assert.throws(() => inspectMalware(directory), /YARA-X reported errors/);
});

test('ClamAV prints a padded day of the month, and its version line still parses', () => {
  const parsed = parseClamavVersion('ClamAV 1.5.4/28001/Thu Sep  3 06:26:15 2026\n');
  assert.equal(parsed.daily, 28001);
  assert.equal(new Date(parsed.date).toISOString(), '2026-09-03T06:26:15.000Z');
});

test('a detection fails the report and is named in it, file digest included', t => {
  const { directory } = fixture(t);
  const malware = join(directory, 'malware');
  mkdirSync(join(directory, 'scanned'));
  writeFileSync(join(directory, 'scanned', 'payload.js'), 'not really malware');
  writeFileSync(join(malware, 'clamav.log'), 'scanned/payload.js: Js.Trojan.Example FOUND\nScanned files: 2\n');
  writeFileSync(join(malware, 'yara.ndjson'), '{"path":"scanned/payload.js","rules":[{"identifier":"EXAMPLE_Rule"}]}\n');
  const detections = collectMalwareDetections(malware, directory);
  assert.deepEqual(detections.map(entry => `${entry.engine} ${entry.signature}`), ['ClamAV Js.Trojan.Example', 'YARA-X EXAMPLE_Rule']);
  assert.ok(detections.every(entry => entry.sha256 === createHash('sha256').update('not really malware').digest('hex')));
  const report = createReport(directory, environment);
  assert.equal(report.status, 'FAIL');
  assert.ok(report.problems.includes('ClamAV and YARA-X malware scan: 2 finding(s)'));
  assert.ok(report.problems.some(problem => problem.startsWith('ClamAV: Js.Trojan.Example in scanned/payload.js (sha256 ')));
});

test('a detection can only be accepted for the exact engine, signature, path and bytes reviewed', () => {
  const detection = { engine: 'YARA-X', signature: 'EXAMPLE_Rule', path: 'node_modules/pkg/index.js', sha256: 'b'.repeat(64) };
  const exception = { ...detection, reason: 'A reviewed false positive.', reference: 'https://example.com/review' };
  assert.ok(reviewMalwareDetections([detection], [exception])[0].exception);
  for (const changed of [{ engine: 'ClamAV' }, { signature: 'OTHER' }, { path: 'node_modules/other.js' }, { sha256: 'c'.repeat(64) }]) {
    assert.equal(reviewMalwareDetections([{ ...detection, ...changed }], [exception])[0].exception, undefined);
  }
  assert.throws(() => reviewMalwareDetections([detection], [{ ...exception, reference: '' }]), /reason and reference/);
});

test('detections outside the scanned tree, and evidence that disagrees with itself, fail', t => {
  const directory = malwareFixture(t);
  writeFileSync(join(directory, 'clamav.log'), '../../etc/passwd: Example FOUND\nScanned files: 2\n');
  assert.throws(() => collectMalwareDetections(directory, directory), /outside the scanned tree/);
  writeMalwareEvidence(directory);
  writeFileSync(join(directory, 'yara.ndjson'), '{"path":"package.json","rules":[{"identifier":"EXAMPLE_Rule"}]}\n');
  assert.throws(() => inspectMalware(directory), /disagree/);
});

/*
 * The Semgrep toolchain is audited like the npm lockfile. An advisory is
 * accepted only for the exact package, version and ID reviewed.
 */
test('a toolchain advisory fails unless that exact package, version and advisory were reviewed', t => {
  const { directory, write } = fixture(t);
  const audit = join(directory, 'dependencies');
  // An advisory the repository's own exceptions do not cover.
  const vulnerable = { dependencies: [{ name: 'Example-Lib', version: '1.0.0',
    vulns: [{ id: 'CVE-2099-0001', aliases: ['GHSA-xxxx-xxxx-xxxx'], fix_versions: ['1.0.1'] }] }], fixes: [] };
  write('dependencies/pip-audit.json', vulnerable);
  writeFileSync(join(audit, 'pip-audit-exit.txt'), '1\n');
  const report = createReport(directory, environment);
  assert.equal(report.status, 'FAIL');
  assert.ok(report.problems.includes('pip: example-lib 1.0.0 CVE-2099-0001 GHSA-xxxx-xxxx-xxxx'));

  const exception = { ecosystem: 'pip', package: 'example-lib', version: '1.0.0', advisory: 'CVE-2099-0001',
    reason: 'Reviewed.', reference: 'https://example.com/advisory' };
  const accepted = inspectPipAudit(audit, [exception]);
  assert.equal(accepted.findings, 0);
  assert.equal(accepted.reviewed[0].label, 'Accepted advisory CVE-2099-0001 in example-lib 1.0.0');
  for (const changed of [{ version: '2.12.0' }, { advisory: 'CVE-2026-1' }, { package: 'jwt' }, { ecosystem: 'npm' }]) {
    assert.equal(inspectPipAudit(audit, [{ ...exception, ...changed }]).findings, 1);
  }
});

test('pip-audit evidence that is missing or contradicts its exit code fails', t => {
  const { directory, write } = fixture(t);
  const audit = join(directory, 'dependencies');
  writeFileSync(join(audit, 'pip-audit-exit.txt'), '1\n');
  assert.throws(() => inspectPipAudit(audit, []), /exited 1 with 0 advisories/);
  write('dependencies/pip-audit.json', { dependencies: [] });
  assert.throws(() => inspectPipAudit(audit, []), /Missing or invalid pip-audit evidence/);
});

test('a release scan must have fetched the release VSIX, and any other scan must not', t => {
  const { directory } = fixture(t);
  const jobs = JSON.parse(environment.SCAN_JOBS);
  const release = { ...environment, RELEASE_TAG: 'v1.2.3' };
  assert.ok(createReport(directory, release).problems.includes('release-asset job: skipped, expected success'));
  jobs['release-asset'] = { result: 'success' };
  assert.equal(createReport(directory, { ...release, SCAN_JOBS: JSON.stringify(jobs) }).status, 'PASS');
  assert.equal(createReport(directory, { ...environment, SCAN_JOBS: JSON.stringify(jobs) }).status, 'FAIL');
});
