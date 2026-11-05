import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const digest = (filename) => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');

export function releaseDefinition(directory = root) {
  const definition = JSON.parse(fs.readFileSync(path.join(directory, 'gateway-release.json'), 'utf8'));
  assert(stableVersion.test(definition.version), 'Gateway release version must be stable X.Y.Z');
  const expectedNotes = `release-notes/gateway-native-v${definition.version}.md`;
  assert.equal(definition.notes, expectedNotes, 'Release notes must belong to this version');
  const notes = path.join(directory, expectedNotes);
  assert(fs.statSync(notes).isFile(), 'Version-specific release notes are required');
  const body = fs.readFileSync(notes, 'utf8').replace(/^<!-- markdownlint-(?:disable|enable)[^\r\n]* -->\r?\n?/gm, '');
  const validation = spawnSync(process.execPath, [path.join(root, 'scripts/validate-release-notes.js'), '--stdin'], {
    encoding: 'utf8', timeout: 15000, input: body,
  });
  assert.equal(validation.status, 0, 'Version-specific release notes failed validation');
  return { version: definition.version, tag: `gateway-native-v${definition.version}`,
    title: `MCP Gateway ${definition.version}`, notes, body };
}

function github(args, allowMissing = false) {
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowMissing && /HTTP 404/.test(result.stderr)) return null;
    throw new Error(`GitHub ${args[0]} failed (${result.status}); ${result.stderr.trim().slice(0, 500)}`);
  }
  if (args[0] !== 'api') return result.stdout;
  if (args.includes('--paginate')) {
    return result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
}

// The workflow verifies the native ZIP's clean provenance before this publisher.
// A draft is the only mutable state: published tags, assets and notes are retained.
export function publishNativeRelease({ repository, sourceRevision, artifact, sha256,
  directory = root, gh = github }) {
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'Invalid repository');
  assert(/^[a-f0-9]{40}$/.test(sourceRevision), 'Invalid source revision');
  assert(/^[a-f0-9]{64}$/.test(sha256), 'Invalid verified artifact digest');
  assert.equal(path.basename(artifact), 'mcp-gateway-windows-x64.zip');
  assert.equal(digest(artifact), sha256, 'Verified artifact bytes changed before publication');
  const checksum = `${artifact}.sha256`;
  assert(fs.readFileSync(checksum, 'utf8').trim().startsWith(`${sha256} `), 'Artifact checksum differs');
  const definition = releaseDefinition(directory);
  const endpoint = `repos/${repository}`;
  const api = (suffix, missing = false) => gh(['api', `${endpoint}/${suffix}`], missing);
  const currentMain = () => {
    assert.equal(api('git/ref/heads/main').object.sha, sourceRevision, 'Refusing to publish a stale main revision');
  };
  const tagRevision = () => api(`commits/${definition.tag}`).sha;
  currentMain();
  // Authenticated listings include drafts; releases/tags only finds published releases.
  const matchingReleases = () => gh(['api', '--paginate', `${endpoint}/releases?per_page=100`,
    '--jq', `.[] | select(.tag_name == "${definition.tag}") | @json`]);
  const matches = matchingReleases();
  assert(matches.length <= 1, 'Gateway version has duplicate releases');
  let release = matches[0];
  const existingTag = api(`git/ref/tags/${definition.tag}`, true);
  if (existingTag) assert.equal(tagRevision(), sourceRevision, 'Release version already belongs to another revision; bump gateway-release.json');
  else {
    if (release) {
      assert.equal(release.draft, true, 'Published version tag is missing');
      assert.equal(release.target_commitish, sourceRevision, 'Pending draft belongs to another revision');
    }
    gh(['api', '--method', 'POST', `${endpoint}/git/refs`,
      '-f', `ref=refs/tags/${definition.tag}`, '-f', `sha=${sourceRevision}`]);
  }
  if (release) {
    assert.equal(tagRevision(), sourceRevision, 'Release version already belongs to another revision; bump gateway-release.json');
    assert.equal(release.prerelease, false, 'Stable gateway release cannot be a prerelease');
    if (!release.draft) {
      for (const name of [path.basename(artifact), path.basename(checksum)]) {
        const assets = release.assets.filter((asset) => asset.name === name);
        assert.equal(assets.length, 1, 'Published release asset inventory is incomplete');
        assert(/^sha256:[a-f0-9]{64}$/.test(assets[0].digest), 'Published asset lacks a GitHub digest');
      }
      return { tag: definition.tag, status: 'already-published' };
    }
  } else {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-release-notes-'));
    try {
      const notes = path.join(temporary, 'notes.md');
      fs.writeFileSync(notes, definition.body);
      gh(['release', 'create', definition.tag, '--repo', repository, '--target', sourceRevision,
        '--title', definition.title, '--notes-file', notes, '--draft', '--latest=false']);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
    const drafts = matchingReleases();
    assert.equal(drafts.length, 1, 'Created draft cannot be resolved');
    release = drafts[0];
  }
  // Upload replacement is allowed only while this exact version remains a draft.
  release = api(`releases/${release.id}`);
  assert.equal(release.draft, true, 'Release was published concurrently');
  assert.equal(tagRevision(), sourceRevision, 'Release tag changed during publication');
  gh(['release', 'upload', definition.tag, artifact, checksum, '--repo', repository, '--clobber']);
  release = api(`releases/${release.id}`);
  assert.equal(release.draft, true, 'Release was published concurrently');
  for (const [name, hash] of [[path.basename(artifact), sha256], [path.basename(checksum), digest(checksum)]]) {
    const assets = release.assets.filter((asset) => asset.name === name);
    assert.equal(assets.length, 1, 'Uploaded release asset inventory is incomplete');
    assert.equal(assets[0].digest, `sha256:${hash}`, 'GitHub asset digest differs from verified artifact');
  }
  assert.equal(tagRevision(), sourceRevision, 'Release tag changed before publication');
  currentMain();
  gh(['api', '--method', 'PATCH', `${endpoint}/releases/${release.id}`,
    '-F', 'draft=false', '-F', 'prerelease=false', '-f', 'make_latest=true']);
  const latest = api('releases/latest');
  assert.equal(latest.tag_name, definition.tag, 'Published version was not selected as latest');
  assert.equal(latest.draft, false);
  assert.equal(latest.prerelease, false);
  return { tag: definition.tag, status: 'published' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--validate') {
      const { version, tag, notes } = releaseDefinition();
      console.log(JSON.stringify({ version, tag, notes }));
    }
    else {
      const [artifact, sha256] = process.argv.slice(2);
      console.log(JSON.stringify(publishNativeRelease({ artifact, sha256,
        repository: process.env.GH_REPO, sourceRevision: process.env.SOURCE_SHA })));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
