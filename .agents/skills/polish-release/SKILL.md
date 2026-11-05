---
name: polish-release
description: Polish an existing GitHub release's body into the project's bilingual (English + Chinese) template format with a References section built from merged PRs. Use when 修改 release、整理发布说明、release notes、编辑 release 内容、发版后整理、polish release、edit release body.
---

<!-- Repository prose keeps one source line per paragraph. -->
<!-- markdownlint-disable MD013 -->

# Polish Release

Polish upstream-style GitHub release notes using the bilingual template. Native gateway releases use committed notes and a separate publication workflow; resolve the release family before generating or editing notes.

## Choose the release workflow

1. Resolve the repository from the user's request or the current checkout with `gh repo view --json nameWithOwner --jq .nameWithOwner`. Use that explicit repository for release reads and writes.
2. Use the requested tag, or inspect `gh release list --repo <repository> --exclude-drafts --exclude-pre-releases --limit 1`. Classify the resolved tag before continuing; `latest` can be a native gateway release.
3. For `gateway-native-vX.Y.Z`, follow **Native gateway releases** below. For upstream-style `vX.Y.Z`, follow **Upstream release workflow**. If the family is unclear, resolve it before generating notes or changing a release.

## Native gateway releases

Read [Versioned Windows releases](../../../docs/development/local-gateway.mdx#versioned-windows-releases) before acting. It owns version identity, committed notes, publication and immutability rules.

- Read `gateway-release.json` and its referenced file under `release-notes/`. Prepare native release descriptions in that canonical file before publication.
- Do not run `scripts/build-release-notes.js` for a native gateway tag or use the upstream `gh release edit` step below. The generator uses upstream comparison URLs and is not the native publisher.
- For a new native version, follow the linked workflow to update the manifest and add its matching notes. Validate the current manifest and rendered notes with `node scripts/publish-gateway-native.mjs --validate`; this command does not publish.
- If the requested native version is already published, report its existing release and apply the linked immutability rule. Do not change its description as a side effect of polishing an upstream release.
- Return after the native workflow; do not fall through to the upstream steps. Follow the repository [task-completion policy](../../../docs/agents/git-and-contribution.md#task-completion) and explicit user restrictions for commit, push and publication.

## Structure contract

The required structure lives in exactly one place: `.github/release-notes-template.md` (read it). It is enforced by `scripts/validate-release-notes.js` (CI runs it on publish/edit). The rules:

- Section order must match the template.
- `Summary`, `摘要`, `References` must be present and non-empty.
- Each optional English section (`Features`/`Fixes`) and its Chinese pair must appear together — never one without the other.
- Optional sections with no content are omitted entirely — never an empty section, never `None`/`无` placeholders.
- `References` bullets use the exact format `<title> by @<login> in <pull url>`, followed by one `Full changelog:` line.
- `New Contributors` bullets use `@<login> made their first contribution in #<number>`.

## Upstream release workflow

1. **Confirm the target.** Use the repository and upstream-style tag resolved above. The upstream tag-push pipeline auto-generates a raw body (`generate_release_notes: true`); these steps convert it to the bilingual template.

2. **Generate the deterministic parts.**

   ```sh
   node scripts/build-release-notes.js <tag>
   ```

   The helper hard-codes `samanhappy/mcphub` comparison URLs and lets `gh` resolve the repository from its environment or checkout. Use it only when both target that upstream repository. For another repository, build the references from its actual merged PRs and comparison range without running this helper unchanged.

   This resolves the previous tag (compare line in the existing body, else `git describe`), fetches merged PRs in the range, and prints a draft skeleton to stdout with `<<FILL: ...>>` markers where you must write content. It reuses the existing body's `## New Contributors` when present and falls back to detecting new contributors itself. It never writes files.

3. **Write the draft in the conversation** (not in the working tree). From the PR list in the skeleton:
   - `## Summary` — one English paragraph on why this release matters.
   - `## 摘要` — Chinese translation of the Summary.
   - `## Features`/`## 功能` — user-facing additions (omit if none).
   - `## Fixes`/`## 修复` — bug fixes, reliability, dependency bumps (omit if none).
   - Translate each bullet into Chinese: PR title in Chinese, then `by @<author>` and URL as-is.
   - Keep `## New Contributors` and `## References` as printed, replacing every `<<FILL: ...>>` marker. Drop any section whose content is empty.

4. **Validate locally before pushing.** Write the finished draft to a throwaway temp file (e.g. `/tmp/release-notes-<tag>.md`, never inside the repo), then:

   ```sh
   node scripts/validate-release-notes.js /tmp/release-notes-<tag>.md
   ```

   On failure: report which section is missing/empty/asymmetric/out-of-order/malformed, fix the draft, re-validate.

5. **Push directly (no confirmation round).**

   ```sh
   gh release edit <tag> --repo <repository> --notes-file /tmp/release-notes-<tag>.md
   ```

6. **Clean up.** Delete the temp file.

## Notes

- Editing a release is externally visible and re-triggers the `release: edited` GitHub event (which runs the validator in CI). Always validate locally first.
- The temp file is only for validation input — keep iteration in the conversation.
- If the existing body already partially follows the template (e.g. a prior run already edited it), reuse the good parts rather than regenerating from scratch.
