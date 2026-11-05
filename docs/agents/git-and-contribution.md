<!-- Repository prose keeps one source line per paragraph. -->
<!-- markdownlint-disable MD013 -->

# Git and contribution workflow

- Use Conventional Commits such as `feat:`, `fix:`, `chore:`, and `refactor:` in imperative present tense.
- Pull requests should describe the behavior change, list automated and manual validation, and link related issues.
- Keep generated artifacts out of commits and pull requests.
- `gh` is not guaranteed to be on the agent shell `PATH`: agent shells run non-interactively with a minimal `PATH` and do not load the user's profile, so a bare `gh ...` can fail with `command not found` even when `gh` is installed. See [development.md](development.md) ("Agent shell `PATH`") for how to locate and export it.

## Task completion

Complete the applicable steps automatically at the end of an implementation task. Honor explicit review-only, pause, no-commit, no-push and no-publication requests at their respective boundaries:

1. Run the checks required by the changed surfaces. Fix in-scope failures and report unavailable checks accurately.
2. Commit only the task-owned changes and push them. Preserve unrelated changes and follow the active branch, merge and protection rules; do not ask for another routine commit/push confirmation.
3. If the shipped gateway package changed, prepare its new version and matching notes before the final commit, then follow [Native gateway releases](#native-gateway-releases) to publish after the task revision reaches `main`. Start the explicit publication workflows and verify their results before reporting delivery complete.
4. For documentation, agent instructions or publication-orchestration changes that do not change the shipped package, finish after commit and push. Do not bump the version or start publication solely for those changes.
5. Report the commit, push destination and checks. When publication was required, include the verified release/image and workflow results. Report a blocked merge or publication as incomplete rather than bypassing protections or claiming success.

Runtime code, bundled dependencies/assets and package construction that changes delivered behavior or contents require publication. The publication procedure remains owned by the linked gateway documentation rather than being duplicated here.

## Native gateway releases

Before preparing or publishing a `gateway-native-vX.Y.Z` release, read [Versioned Windows releases](../development/local-gateway.mdx#versioned-windows-releases). That section owns the version manifest, committed release notes, publication checks, and installer channel. Keep this workflow separate from upstream `vX.Y.Z` release polishing.

## UI screenshots in pull requests

- Unless explicitly requested otherwise, use the English UI for all screenshots.

- Any pull request with visible UI changes must include browser screenshots in the PR body or a PR comment. Upload the images to GitHub so reviewers can view them; local file paths do not count.
- Show before/after screenshots for changes to existing UI, or the resulting state for new UI. Capture the affected states and viewport sizes, including mobile when responsive behavior changes.
- Label viewport sizes and disclose mocked data or simulated states. Verify that the uploaded images render in the PR before considering the task complete.

## Public documentation formatting

- In Markdown and MDX prose, keep each paragraph on one source line and separate paragraphs with a blank line. Do not manually wrap prose to a fixed column width; let the editor or viewer wrap it visually. Preserve intentional line breaks in lists, tables, code blocks, and MDX components.
- Match the surrounding formatting and apply the same paragraph convention to both English and Chinese documentation. Avoid reformatting unrelated content.

## Issue tracker

GitHub Issues for `samanhappy/mcphub` are operated with `gh`. See [issue-tracker.md](issue-tracker.md) for commands and [triage-labels.md](triage-labels.md) for the canonical labels.

## Pull request review

Prefer the `gh` CLI over scraping the GitHub web UI or hand-calling the REST API. For a review, read the structured metadata, per-file patches, and the linked issue with:

```bash
gh pr view <number> --json title,body,files,commits,mergeable,headRefName,baseRefName
gh pr diff <number>
gh issue view <number>
```

`gh pr diff` prints the same unified diff as the web view. When the PR branch exists locally, cross-check it against the remote before judging the change:

```bash
git fetch origin pull/<number>/head:<local-branch>
git diff main...<local-branch> --stat
```

## Security advisories and code scanning

Reading, accepting, updating, and publishing repository security advisories is a
dedicated workflow with its own state machine, CVE flow, and disclosure ordering:
see [security-advisories.md](security-advisories.md).

For code-scanning alerts, use `gh api` as the primary interface instead of the
web page, which may hide details without the required session:

```bash
gh auth status
gh api repos/samanhappy/mcphub/code-scanning/alerts/<alert_number>
gh api repos/samanhappy/mcphub/code-scanning/alerts/<alert_number>/instances
```

Compare alerts against the current `main` and the tagged fix commit before
deciding whether an issue is still live.
