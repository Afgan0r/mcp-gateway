import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishNativeRelease, releaseDefinition } from '../../scripts/publish-gateway-native.mjs';

const revision = 'a'.repeat(40);
const tag = 'gateway-native-v9.8.7';
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fixture(t, initial = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const artifact = path.join(directory, 'mcp-gateway-windows-x64.zip');
  fs.mkdirSync(path.join(directory, 'release-notes'));
  const notes = `release-notes/${tag}.md`;
  fs.writeFileSync(path.join(directory, 'gateway-release.json'), JSON.stringify({ version: '9.8.7', notes }));
  fs.writeFileSync(path.join(directory, notes), '## Summary\n\nFixture release.\n\n## 摘要\n\n测试版本。\n\n## References\n\n- Full changelog: https://github.com/example/gateway/compare/v9.8.6...v9.8.7\n');
  fs.writeFileSync(artifact, 'already-verified-zip-fixture');
  fs.writeFileSync(`${artifact}.sha256`, `${hash(artifact)}  ${path.basename(artifact)}\n`);
  const state = { head: revision, release: null, tagRevision: null, writes: [], ...initial };
  const gh = (args) => {
    if (args[0] === 'release' && args[1] === 'view') {
      return state.release ? { apiUrl: 'https://api.github.com/repos/Afgan0r/mcp-gateway/releases/123' } : null;
    }
    if (args[0] === 'api' && args[1] !== '--method') {
      const endpoint = args[1];
      if (endpoint.endsWith('/git/ref/heads/main')) return { object: { sha: state.head } };
      if (endpoint.endsWith(`/commits/${tag}`)) return { sha: state.tagRevision };
      if (endpoint.endsWith(`/git/ref/tags/${tag}`)) return state.tagRevision ? { object: { sha: state.tagRevision } } : null;
      if (endpoint.endsWith('/releases/123') || endpoint.endsWith('/releases/latest')) return structuredClone(state.release);
      throw new Error(`Unrecognized read: ${endpoint}`);
    }
    state.writes.push(args);
    if (args[0] === 'api' && args[1] === '--method') {
      if (args[2] === 'DELETE') {
        assert(state.release.draft, 'Published assets must never be overwritten');
        state.release.assets = state.release.assets.filter((asset) => !args[3].endsWith(`/${asset.id}`));
        return;
      }
      if (args[2] === 'POST') {
        if (args[3].startsWith('https://uploads.github.com/')) {
          assert(state.release.draft, 'Published assets must never be overwritten');
          const file = args[args.indexOf('--input') + 1];
          const asset = { id: state.release.assets.length + 10, name: path.basename(file), digest: `sha256:${hash(file)}` };
          if (state.corruptUpload) asset.digest = `sha256:${'0'.repeat(64)}`;
          state.release.assets.push(asset);
          if (state.moveMain) state.head = 'b'.repeat(40);
          return structuredClone(asset);
        }
        if (args[3].endsWith('/git/refs')) {
          assert(args.includes(`ref=refs/tags/${tag}`));
          assert(args.includes(`sha=${revision}`));
          state.tagRevision = revision;
          return;
        }
        assert(args[3].endsWith('/releases'));
        assert(args.includes('draft=true'));
        assert(args.includes('make_latest=false'));
        assert.equal(state.tagRevision, revision, 'Version ref must precede draft creation');
        const notes = args.find((arg) => arg.startsWith('body=@')).slice('body=@'.length);
        assert(fs.readFileSync(notes, 'utf8').includes('## Summary'));
        state.release = { id: 123, tag_name: tag, draft: true, prerelease: false, assets: [] };
        return structuredClone(state.release);
      }
      assert(args.includes('draft=false'));
      assert(args.includes('make_latest=true'));
      assert.equal(state.release.assets.length, 2);
      state.release.draft = false;
    } else throw new Error('Unexpected mutation');
  };
  return { state, publish: () => publishNativeRelease({ repository: 'Afgan0r/mcp-gateway',
    sourceRevision: revision, artifact, sha256: hash(artifact), directory, gh }) };
}

test('canonical release definition has dedicated validated notes', () => {
  const definition = releaseDefinition();
  assert(definition.tag.startsWith('gateway-native-v'));
  assert(definition.notes.endsWith(`${definition.tag}.md`));
  assert(!definition.body.includes('<!--'), 'Published notes exclude source lint directives');
});
test('publishes a complete draft as the latest stable version', (t) => {
  const { state, publish } = fixture(t);
  assert.deepEqual(publish(), { tag, status: 'published' });
  assert.equal(state.release.draft, false);
  assert.equal(state.writes.length, 5);
  assert(!state.writes.some((args) => args.some((value) => value.includes('gateway-native-latest'))));
});
test('a repeated publication preserves the original assets and metadata', (t) => {
  const { state, publish } = fixture(t);
  publish();
  const published = structuredClone(state.release);
  state.writes.length = 0;
  assert.equal(publish().status, 'already-published');
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.release, published);
});
test('resumes an interrupted draft without creating another release', (t) => {
  const { state, publish } = fixture(t, { tagRevision: revision,
    release: { id: 123, tag_name: tag, draft: true, prerelease: false, assets: [] } });
  publish();
  assert.equal(state.writes.length, 3);
  assert.equal(state.release.draft, false);
});
test('replaces incomplete assets only inside a verified draft', (t) => {
  const { state, publish } = fixture(t, { tagRevision: revision,
    release: { id: 123, tag_name: tag, draft: true, prerelease: false,
      assets: [{ id: 7, name: 'mcp-gateway-windows-x64.zip', digest: `sha256:${'0'.repeat(64)}` }] } });
  publish();
  assert.equal(state.release.assets.length, 2);
  assert(state.writes.some((args) => args[2] === 'DELETE'));
});
test('resumes an untagged draft only when its exact source is verified', (t) => {
  const { state, publish } = fixture(t, {
    release: { id: 123, tag_name: tag, draft: true, prerelease: false, assets: [], target_commitish: revision } });
  publish();
  assert.equal(state.tagRevision, revision);
  assert.equal(state.release.draft, false);
});
test('an untagged draft for another source is preserved without mutations', (t) => {
  const { state, publish } = fixture(t, {
    release: { id: 123, tag_name: tag, draft: true, prerelease: false, assets: [], target_commitish: 'b'.repeat(40) } });
  assert.throws(publish, /Pending draft belongs to another revision/);
  assert.deepEqual(state.writes, []);
});
test('an existing version cannot be repointed to another source revision', (t) => {
  const { state, publish } = fixture(t, { tagRevision: 'b'.repeat(40),
    release: { id: 123, tag_name: tag, draft: false, prerelease: false, assets: [] } });
  assert.throws(publish, /bump gateway-release.json/);
  assert.deepEqual(state.writes, []);
});
test('stale main is rejected before creating a draft', (t) => {
  const { state, publish } = fixture(t, { head: 'b'.repeat(40) });
  assert.throws(publish, /stale main/);
  assert.deepEqual(state.writes, []);
});
for (const [option, pattern] of [['corruptUpload', /digest differs/], ['moveMain', /stale main/]]) {
  test(`${option} leaves an incomplete release unpublished`, (t) => {
    const { state, publish } = fixture(t, { [option]: true });
    assert.throws(publish, pattern);
    assert.equal(state.release.draft, true);
    assert(!state.writes.some((args) => args[1] === '--method' && args[2] === 'PATCH'));
  });
}
