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

function readText(directory, name) {
  return readFileSync(join(directory, name), 'utf8');
}

function exitCode(directory, name) {
  const code = Number(readText(directory, name).trim());
  requireEvidence(Number.isInteger(code), `Missing exit code: ${name}`);
  return code;
}

/** `path: Signature FOUND`, one line per infected file. */
export function clamavDetections(log) {
  return log.split('\n').flatMap(line => {
    const match = /^(.+): (\S+) FOUND$/.exec(line.trimEnd());
    return match ? [{ engine: 'ClamAV', signature: match[2], path: match[1] }] : [];
  });
}

/** YARA-X prints one JSON object per matching file, and nothing for a clean one. */
export function yaraDetections(ndjson) {
  return ndjson.split('\n').filter(line => line.trim() !== '').flatMap(line => {
    const record = JSON.parse(line);
    requireEvidence(typeof record.path === 'string' && Array.isArray(record.rules), 'Invalid YARA-X result');
    return record.rules.map(rule => {
      requireEvidence(typeof rule.identifier === 'string', 'Invalid YARA-X rule match');
      return { engine: 'YARA-X', signature: rule.identifier, path: record.path };
    });
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `ClamAV 1.5.4/28138/Tue Sep 29 06:26:15 2026`: engine, daily database version and its build time. */
export function parseClamavVersion(text) {
  const match = /^ClamAV (\d+\.\d+\.\d+)\/(\d+)\/\w{3} (\w{3}) +(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})\s*$/m.exec(text);
  const month = match ? MONTHS.indexOf(match[3]) : -1;
  requireEvidence(match && month >= 0, 'Unreadable ClamAV version');
  const [, engine, daily, , day, hours, minutes, seconds, year] = match;
  return { engine, daily: Number(daily),
    date: Date.UTC(Number(year), month, Number(day), Number(hours), Number(minutes), Number(seconds)) };
}

/**
 * Records every detection with the SHA-256 of the file it was made in.
 *
 * Run where the scanned files are. An accepted detection is bound to the exact
 * bytes that were reviewed, so a changed file needs another review, and the
 * report job can judge the evidence without the files themselves.
 */
export function collectMalwareDetections(directory, root = process.cwd(), engines = MALWARE_ENGINES) {
  return engines.flatMap(engine => {
    const detections = rawDetections(directory, engine).map(detection => {
      const path = resolve(root, detection.path);
      requireEvidence(!isAbsolute(detection.path) && !relative(root, path).startsWith('..'),
        `Detection outside the scanned tree: ${detection.path}`);
      return { ...detection, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
    });
    // One file per engine, since each engine runs in its own job.
    writeFileSync(join(directory, `detections-${engine}.json`), `${JSON.stringify(detections, null, 2)}\n`);
    return detections;
  });
}

/** Each malware engine by the id of the job that runs it. */
export const MALWARE_ENGINES = ['clamav', 'yara-x'];

function rawDetections(directory, engine) {
  return engine === 'clamav'
    ? clamavDetections(readText(directory, 'clamav.log'))
    : yaraDetections(readText(directory, 'yara.ndjson'));
}

export function reviewMalwareDetections(detections, exceptions) {
  requireEvidence(Array.isArray(exceptions), 'Invalid malware exceptions');
  return detections.map(detection => {
    const exception = exceptions.find(entry => entry.engine === detection.engine && entry.signature === detection.signature
      && entry.path === detection.path && entry.sha256 === detection.sha256);
    if (exception) {
      requireEvidence(typeof exception.reason === 'string' && exception.reason.length > 0
        && typeof exception.reference === 'string' && exception.reference.length > 0, 'Exception requires a reason and reference');
    }
    return { ...detection, exception };
  });
}

/** Signatures older than this mean freshclam did not update them. */
const SIGNATURE_AGE_LIMIT_MS = 3 * 24 * 60 * 60 * 1000;

function inspectClamav(directory, targets, now) {
  // Each engine proves itself on the EICAR test file before its clean result counts.
  requireEvidence(exitCode(directory, 'clamav-anchor-exit.txt') === 1
    && clamavDetections(readText(directory, 'clamav-anchor.log')).some(entry => entry.signature === 'Eicar-Test-Signature'),
  'ClamAV did not detect the EICAR test file');
  const clamavExit = exitCode(directory, 'clamav-exit.txt');
  requireEvidence(clamavExit === 0 || clamavExit === 1, `ClamAV scan failed with exit code ${clamavExit}`);
  const scanned = Number(/^Scanned files: (\d+)$/m.exec(readText(directory, 'clamav.log'))?.[1]);
  requireEvidence(scanned === targets.length, `ClamAV scanned ${Number.isNaN(scanned) ? 'an unknown number' : scanned} of ${targets.length} files`);
  const version = parseClamavVersion(readText(directory, 'clamav-version.txt'));
  requireEvidence(now - version.date < SIGNATURE_AGE_LIMIT_MS, 'ClamAV signatures are more than three days old; freshclam did not update them');
  return [{ name: 'ClamAV', version: `${version.engine}, daily signatures ${version.daily} of ${new Date(version.date).toISOString()}` }];
}

function inspectYara(directory) {
  requireEvidence(exitCode(directory, 'yara-anchor-exit.txt') === 0
    && yaraDetections(readText(directory, 'yara-anchor.ndjson')).some(entry => /eicar/i.test(entry.signature)),
  'YARA-X did not detect the EICAR test file');
  requireEvidence(exitCode(directory, 'yara-exit.txt') === 0, 'YARA-X scan failed');
  requireEvidence(readText(directory, 'yara.err').trim() === '', 'YARA-X reported errors');
  const pins = readJson(join(directory, 'yara-pins.json'));
  return [
    { name: 'YARA-X', version: readText(directory, 'yara-version.txt').trim() },
    { name: 'YARA Forge rules', version: `${pins.yara_forge.release} ${pins.yara_forge.asset} sha256:${pins.yara_forge.sha256}` },
  ];
}

/** Judges the evidence of the engines named, both by default. */
export function inspectMalware(directory, now = Date.now(), engines = MALWARE_ENGINES) {
  const targets = readText(directory, 'targets.txt').split('\n').filter(Boolean);
  requireEvidence(targets.length > 0, 'The malware scan listed no files');
  // Recorded rather than scanned: an empty file has nothing to match.
  const empty = readText(directory, 'empty.txt').split('\n').filter(Boolean);
  const tools = engines.flatMap(engine => engine === 'clamav' ? inspectClamav(directory, targets, now) : inspectYara(directory));

  const detections = engines.flatMap(engine => {
    const recorded = readJson(join(directory, `detections-${engine}.json`));
    requireEvidence(Array.isArray(recorded) && recorded.length === rawDetections(directory, engine).length,
      'Malware detections and raw results disagree');
    return recorded;
  });
  const reviewed = reviewMalwareDetections(detections, readJson('.github/security/malware-exceptions.json'));
  const unexpected = reviewed.filter(entry => !entry.exception);
  return {
    findings: unexpected.length,
    details: unexpected.map(entry => `${entry.engine}: ${entry.signature} in ${entry.path} (sha256 ${entry.sha256})`),
    reviewed: reviewed.filter(entry => entry.exception).map(entry => ({ path: entry.path, signature: entry.signature,
      engine: entry.engine, sha256: entry.sha256, reason: entry.exception.reason, reference: entry.exception.reference })),
    scannedFiles: targets.length,
    emptyFiles: empty.length,
    tools,
  };
}

function inspectAudit(directory) {
  const data = readJson(join(directory, 'npm-audit.json'));
  const findings = data.metadata?.vulnerabilities?.total;
  requireEvidence(!data.error && data.auditReportVersion === 2 && Number.isInteger(findings) && findings >= 0
    && data.vulnerabilities && typeof data.vulnerabilities === 'object', 'Missing or invalid npm audit evidence');
  requireEvidence(Object.keys(data.vulnerabilities).length === findings, 'Inconsistent npm vulnerability count');
  return { findings, tools: [{ name: 'npm audit', version: 'Node 22 bundled npm' }] };
}

/*
 * The Security and Malware scan workflows each write one report: which jobs
 * must have succeeded, what judges their evidence, and what the report says.
 */
const REPORTS = {
  security: {
    title: 'Wicker security report',
    file: 'security-report',
    jobs: ['revision', 'codeql', 'semgrep', 'dependencies'],
    scanners: [
      ['CodeQL JavaScript/TypeScript', 'codeql-javascript-typescript', inspectSarif],
      ['CodeQL GitHub Actions', 'codeql-actions', inspectSarif],
      ['Semgrep', 'semgrep', inspectSemgrep],
      ['npm audit (including development tools)', 'dependencies', inspectAudit],
    ],
    scope: () => ['Scope: CodeQL security-extended for JavaScript/TypeScript and GitHub Actions; Semgrep Community Edition p/security-audit and p/secrets; npm lockfile audit including development tools. Semgrep registry rules and vulnerability advisories are fetched at scan time. Generated output and dependencies are excluded from source scanning. The malware scan of the checkout and the VSIX has its own report.', ''],
    subject: 'commit',
  },
  malware: {
    title: 'Wicker malware report',
    file: 'malware-report',
    jobs: ['revision', ...MALWARE_ENGINES],
    releaseAsset: true,
    scanners: [['ClamAV and YARA-X malware scan', 'malware', directory => inspectMalware(directory)]],
    scope: tag => [
      'Scope: ClamAV and YARA-X with the YARA Forge full rule set over the checkout, its installed dependencies and the VSIX. ClamAV signatures are fetched at scan time; the YARA-X engine and YARA Forge release are pinned by SHA-256.', '',
      `VSIX: ${tag ? 'the asset attached to the release, checked against the digest GitHub records for it' : 'built from the scanned commit'}. Each malware engine must detect the EICAR test file before its clean result counts.`, '',
    ],
    subject: 'commit and VSIX',
  },
};

export function createReport(directory, environment, kind = 'security') {
  const spec = REPORTS[kind];
  mkdirSync(directory, { recursive: true });
  const problems = [];
  let jobs = {};
  try {
    jobs = JSON.parse(environment.SCAN_JOBS ?? '{}');
    for (const name of spec.jobs) {
      requireEvidence(jobs[name]?.result === 'success', `${name} job: ${jobs[name]?.result ?? 'missing'}`);
    }
    if (spec.releaseAsset) {
      // A release scan examines the VSIX attached to the release, so fetching it
      // has to have happened; anything else builds its own and skips the fetch.
      const expected = environment.RELEASE_TAG ? 'success' : 'skipped';
      requireEvidence(jobs['release-asset']?.result === expected,
        `release-asset job: ${jobs['release-asset']?.result ?? 'missing'}, expected ${expected}`);
    }
  } catch (error) {
    problems.push(error.message);
  }
  const sha = environment.SCAN_SHA ?? '';
  if (!/^[a-f0-9]{40}$/.test(sha)) problems.push('Missing or invalid scanned commit');

  const scanners = spec.scanners.map(([name, folder, inspect]) => {
    try {
      const result = inspect(join(directory, folder));
      if (result.findings > 0) problems.push(`${name}: ${result.findings} finding(s)`, ...(result.details ?? []));
      return { name, ...result };
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
      return { name, findings: null, error: error.message };
    }
  });

  const evidence = filesIn(directory)
    .filter(path => ![`${spec.file}.md`, `${spec.file}.json`].includes(relative(directory, path)))
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
    `# ${spec.title}`, '',
    `Result: **${report.status}**`, '',
    `Commit: \`${sha}\``, '',
    `Release: ${report.tag ?? 'not a release scan'}`, '',
    `Generated: ${report.generatedAt}`, '',
    `[Workflow run](${report.run})`, '',
    '| Analysis | Unexpected findings | Reviewed exceptions |', '| --- | --- | --- |',
    ...scanners.map(scanner => `| ${scanner.name} | ${scanner.findings ?? 'Unavailable (failed)'} | ${scanner.reviewed?.length ?? 0} |`), '',
    ...problems.map(problem => `- ${problem.replaceAll('\n', ' ')}`), '',
    ...scanners.flatMap(scanner => (scanner.reviewed ?? []).map(entry =>
      `- ${entry.label ?? `Reviewed false positive in \`${entry.path}\``}: ${entry.reason} [Reference](${entry.reference})`)), '',
    'Policy: every unexpected finding fails, regardless of severity. The only exceptions are the exact reviewed findings listed above, matched against file content hashes or, for an advisory, the exact package version and advisory ID. Scanner failures, warnings, skipped jobs and missing or malformed evidence fail the gate.', '',
    ...spec.scope(report.tag),
    `Raw results and their SHA-256 digests accompany this report. It records the checks performed on the named ${spec.subject}; it is not an audit or a certification. A passing scan does not prove the absence of vulnerabilities or malware.`, '',
  ].join('\n');
  writeFileSync(join(directory, `${spec.file}.json`), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(directory, `${spec.file}.md`), markdown);
  if (environment.GITHUB_STEP_SUMMARY) appendFileSync(environment.GITHUB_STEP_SUMMARY, markdown);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [, , command, directory] = process.argv;
    requireEvidence(directory, 'Usage: node security-report.mjs <sarif|semgrep|clamav|yara-x|report|malware-report> <directory>');
    if (command === 'sarif') {
      const { findings } = inspectSarif(directory);
      requireEvidence(findings === 0, `${findings} security finding(s)`);
    } else if (command === 'semgrep') {
      const { findings, reviewed } = inspectSemgrep(directory, true);
      console.log(`Semgrep: ${findings} unexpected finding(s), ${reviewed.length} reviewed false positive(s)`);
      requireEvidence(findings === 0, `${findings} unexpected Semgrep finding(s)`);
    } else if (MALWARE_ENGINES.includes(command)) {
      collectMalwareDetections(directory, process.cwd(), [command]);
      const { findings, details, reviewed, scannedFiles, emptyFiles } = inspectMalware(directory, Date.now(), [command]);
      console.log(`Malware scan (${command}): ${scannedFiles} files and ${emptyFiles} empty, ${findings} unexpected detection(s), ${reviewed.length} reviewed`);
      for (const detail of details) console.error(detail);
      requireEvidence(findings === 0, `${findings} unexpected malware detection(s)`);
    } else if (command === 'report' || command === 'malware-report') {
      const kind = command === 'report' ? 'security' : 'malware';
      const report = createReport(directory, process.env, kind);
      console.log(`${kind === 'security' ? 'Security' : 'Malware'} report: ${report.status}`);
      process.exitCode = report.status === 'PASS' ? 0 : 1;
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
