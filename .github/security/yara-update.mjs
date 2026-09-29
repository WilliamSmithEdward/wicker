// Proposes new YARA-X and YARA Forge pins for .github/security/yara.json.
//
// Nothing is downloaded here. Each SHA-256 is the digest GitHub records for
// the release asset, and the Security workflow refuses any download that does
// not match it, so the scan of the proposal is also the check of the pin.
//
// YARA Forge publishes detection content on a schedule, so its newest release
// is proposed. YARA-X is software, so a release is proposed once it is a week
// old, the same cooldown Dependabot applies to everything else here.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PINS = '.github/security/yara.json';
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// Where the pins come from is fixed here rather than read from the pins file,
// so nothing written into that file can steer where this script connects.
const ENGINE_REPOSITORY = 'VirusTotal/yara-x';
const RULES_REPOSITORY = 'YARAHQ/yara-forge';
const RULES_ASSET = 'yara-forge-rules-full.zip';
const engineAsset = tag => `yara-x-${tag}-x86_64-unknown-linux-gnu.tar.gz`;

async function api(path) {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${path}: ${response.status}`);
  return response.json();
}

/** The asset's recorded digest, as the pins file stores it. */
function digestOf(release, name) {
  const asset = release.assets.find(entry => entry.name === name);
  const match = /^sha256:([a-f0-9]{64})$/.exec(asset?.digest ?? '');
  if (!match) throw new Error(`${release.tag_name} has no recorded SHA-256 for ${name}`);
  return match[1];
}

function versionOf(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return match ? match.slice(1).map(Number) : undefined;
}

function newer(left, right) {
  for (let at = 0; at < 3; at++) {
    if (left[at] !== right[at]) return left[at] > right[at];
  }
  return false;
}

export async function propose(pins, now = Date.now()) {
  if (pins.engine.repository !== ENGINE_REPOSITORY || pins.rules.repository !== RULES_REPOSITORY
    || pins.rules.asset !== RULES_ASSET || pins.engine.asset !== engineAsset(pins.engine.tag)) {
    throw new Error(`${PINS} names a repository or asset this updater does not follow`);
  }
  const next = structuredClone(pins);

  const forge = await api(`repos/${RULES_REPOSITORY}/releases/latest`);
  if (forge.tag_name !== pins.rules.tag) {
    next.rules.tag = forge.tag_name;
    next.rules.sha256 = digestOf(forge, RULES_ASSET);
  }

  const current = versionOf(pins.engine.tag);
  const candidates = (await api(`repos/${ENGINE_REPOSITORY}/releases?per_page=30`))
    .filter(release => !release.draft && !release.prerelease && versionOf(release.tag_name)
      && now - Date.parse(release.published_at) >= COOLDOWN_MS)
    .sort((left, right) => (newer(versionOf(left.tag_name), versionOf(right.tag_name)) ? -1 : 1));
  const engine = candidates[0];
  if (engine && current && newer(versionOf(engine.tag_name), current)) {
    next.engine.tag = engine.tag_name;
    next.engine.asset = engineAsset(engine.tag_name);
    next.engine.sha256 = digestOf(engine, next.engine.asset);
  }
  return next;
}

function describe(pins, next) {
  const lines = [];
  for (const part of ['engine', 'rules']) {
    const before = pins[part];
    const after = next[part];
    if (before.tag === after.tag) continue;
    lines.push(`- ${after.repository}: ${before.tag} to [${after.tag}](https://github.com/${after.repository}/releases/tag/${after.tag}), \`${after.asset}\` sha256 \`${after.sha256}\``);
  }
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const pins = JSON.parse(readFileSync(PINS, 'utf8'));
  const next = await propose(pins);
  const changes = describe(pins, next);
  const output = process.env.GITHUB_OUTPUT;
  if (changes.length === 0) {
    console.log('YARA-X and YARA Forge pins are current.');
    if (output) appendFileSync(output, 'changed=false\n');
  } else {
    writeFileSync(PINS, `${JSON.stringify(next, null, 2)}\n`);
    const body = [
      'Updates the malware scan pins in `.github/security/yara.json`.', '',
      ...changes, '',
      'Each SHA-256 is the digest GitHub records for the release asset. The Malware scan workflow started on this branch downloads the assets, refuses any that do not match, proves the engine on the EICAR test file and scans the repository with the new rules. Merge only when that run passes.',
    ].join('\n');
    writeFileSync('yara-update.md', `${body}\n`);
    console.log(body);
    if (output) appendFileSync(output, `changed=true\ntitle=Update YARA pins: ${[next.engine.tag, `YARA Forge ${next.rules.tag}`].join(', ')}\n`);
  }
}
