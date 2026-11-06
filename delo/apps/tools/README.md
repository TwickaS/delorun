# Delo tools

English | [中文](README.zh.md)

`@delo/tools` is Delo's fork tooling, a private package in `delo/apps/tools`.
It holds the divergence-ledger checker, which keeps every difference between this tree and its pinned upstream commit recorded, and the count of that difference.
It also holds the gates that check each change, the commit standard, and the inventory of upstream's workflows.
The check runner that orders and runs the gates, the local stack and the other fork tools arrive with later work packages.

## Modules

- `src/fork-boundary.ts` holds the ledger schema, the matcher for fork-owned paths and globs, the boundary errors and the divergence total.
- `src/check-fork-boundary.ts` is the command-line gate. It reads the ledger, checks the repository against it, and prints the count with `--count`.
- `src/check-commits.ts` is the commit standard: a Conventional Commits subject, a DCO sign-off, and a changelog fragment or a `Changelog: none (<reason>)` trailer. It checks one message with `--message <file>`, the form a `commit-msg` hook passes.
- `src/checks/types.ts` and `src/checks/gates/index.ts` describe each gate as one command that the check runner executes.
- `src/checks/gates/` holds the gate modules and their data: licence, secrets, personal data, infrastructure, DCO, documentation times and the documentation checks.
- `src/git.ts` runs git for the modules and reports exit statuses.
- `tests/` holds the specs. The ledger rules run against temporary git repositories. The gate specs plant one violation per gate in temporary trees, and the documentation specs run upstream's scripts on planted fixture trees.

## The divergence ledger

[`delo/upstream-patches.json`](../../upstream-patches.json) records how this tree differs from upstream.
`upstream.commit` pins the upstream commit that the differences are measured against.
`forkOwned` lists paths and globs that Delo owns outright. `*` matches within one path segment and `**` across segments. An entry covers the paths it matches and every path below a matching directory.
`patches` lists each upstream path that Delo edits, adds or deletes, with its `class` (`delo-feature`, `generic-fix` or `security`) and a `reason`.
`retired` lists entries whose change upstream absorbed. Each names the upstream commit that absorbed it and the hunks it had.

The checker fails when:

- the ledger does not parse, or a patch lacks its class or reason;
- the pinned commit is not in the clone or is not an ancestor of HEAD;
- an absorbing commit is not in the history of the pinned commit;
- an upstream path differs from the pinned commit and is neither fork-owned nor listed;
- a listed patch no longer differs from the pinned commit;
- a retired entry still differs from the pinned commit;
- a fork-owned tree holds a compiled twin of a TypeScript source.

`--count` prints the listed entries and their hunks. A hunk is one `@@` header of `git diff --unified=0` against the pinned commit, and an untracked file counts as one hunk. Retired entries are credited and listed separately; they are not part of the count.

## The gates

[`src/checks/gates/index.ts`](src/checks/gates/index.ts) lists each gate as a command that the runner executes from the repository root. A gate passes when its command exits 0. A staged gate accepts paths as trailing arguments, which the runner appends at pre-commit. A range gate compares the commits from `origin/v5` to HEAD unless it is given `--base <rev>`.

| Gate | Staged | Refuses or checks |
|---|---|---|
| `gates:licence` | no | Every package under `delo/` declares MIT, and the root `LICENSE` is the MIT licence. |
| `gates:secrets` | yes | Token-shaped strings, private keys and secrets-file names, with secretlint's recommended preset and DeepSeek's key shape. A finding on a line that upstream holds word for word passes. |
| `gates:personal-data` | yes | The salted hashes of the personal-data patterns, in the staged paths and in the Author, Committer and Signed-off-by lines of the range, and postal addresses by shape in those paths and in commit messages. The plain patterns live only in `~/.config/delo/personal-data.txt`; `--rehash` regenerates [`personal-data.hashes.json`](src/checks/gates/personal-data.hashes.json) from that file and exits 1 when it is absent. |
| `gates:infrastructure` | yes | IPv4 addresses outside loopback, the unspecified and broadcast addresses, and the RFC 5737 documentation ranges, tailnet names other than `example.ts.net`, and cloud account IDs. Documented exceptions are listed by path and value in [`infrastructure.allowlist.json`](src/checks/gates/infrastructure.allowlist.json). |
| `gates:dco` | no | Every non-merge commit of the range has a `Signed-off-by` line whose name and email are the author's. |
| `gates:commits` | no | The commit standard over the range, with the changelog rule. |
| `gates:doc-times` | no | A line the range adds to a Markdown file under `delo/` carries no deadline, quarter, schedule estimate or promise of timing. |
| `gates:docs` | no | Upstream's bilingual-pair, word-budget, hard-wrap, relative-link and TypeScript-fence checks over `delo/docs/`. |

The [gates workflow](../../../.github/workflows/gates.yml) runs each gate on pull requests and on pushes to `v5` and `main`, and passes each pull request's base or each push's previous tip as the range. Its personal-data step reads commit metadata against the committed hashes only.

## Workflows

Upstream's workflows are in [`.github/workflows`](../../../.github/workflows). Each row names a workflow's triggers, what it needs from DeepSeek, and Delo's disposition. **Keep** means the workflow runs in this repository, with any runner routing its ledger entry names. **Guard** means its jobs carry `if: github.repository == 'deepseek-ai/deepseek-harness'`, so they run only in upstream's repository; each guarded file has a `delo-feature` entry in the ledger. Delo's own workflow is [`gates.yml`](../../../.github/workflows/gates.yml).

| Workflow | Triggers | Needs DeepSeek secrets or infrastructure | Disposition |
|---|---|---|---|
| `build-exe-for-python-sdk.yml` | `workflow_call`, `workflow_dispatch` | Secret `DEEPSEEK_API_KEY_EXTERNAL` for installed-wheel real-API tests | Guard |
| `build-exe-for-ssh-helper.yml` | `workflow_call`, `workflow_dispatch` | None; GitHub-hosted runners | Keep |
| `build-preview-cloudflare.yml` | `pull_request` | Cloudflare Pages and Access secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`) | Guard |
| `ci-master.yml` | `push` to `master`, `workflow_dispatch` | Secret `DEEPSEEK_API_KEY_EXTERNAL`; self-hosted runners `dsh-win-ci` and `vm-backup` | Guard |
| `ci-python.yml` | `pull_request` | Secret `DEEPSEEK_API_KEY_EXTERNAL` for the installed-wheel test | Guard |
| `ci-windows.yml` | `pull_request` | None needed. Upstream's runner labels apply only in upstream's repository (see the note below) | Keep, routed |
| `ci.yml` | `pull_request` | None needed. Upstream's runner labels apply only in upstream's repository (see the note below) | Keep, routed |
| `cua-helper-package.yml` | `workflow_dispatch`, `workflow_call` | Self-hosted runner `dsh-mac-package-trial` with the signing configuration | Guard |
| `desktop-publish.yml` | `workflow_dispatch` | Self-hosted runner routing through `DESKTOP_PUBLISH_RUNNERS`; environments `desktop-test` and `desktop-production` | Guard |
| `docs-pages.yml` | `workflow_dispatch` | GitHub Pages environment `github-pages` and a Blacksmith runner | Guard |
| `e2e.yml` | `workflow_dispatch`, `push` to `main` and `master`, `pull_request`, nightly `schedule` | Secret `DEEPSEEK_API_KEY_EXTERNAL` for the real DeepSeek API | Guard |
| `expected-filenames.yml` | `pull_request` | None; GitHub-hosted runner | Keep |
| `issue-lifecycle.yml` | `issues`, `pull_request`, `pull_request_review` | GitHub App secret `DSH_ISSUE_APP_PRIVATE_KEY` and variable `DSH_ISSUE_APP_CLIENT_ID`; upstream's issue types and fields | Guard |
| `issue-policy.yml` | `pull_request`, `pull_request_review` | The same GitHub App secret and variable | Guard |
| `macos-intel-package.yml` | `workflow_dispatch` | Self-hosted runner `dsh-mac-package-trial`; signing and update channels | Guard |
| `macos-package.yml` | `workflow_dispatch` | Self-hosted runner `dsh-mac-package-trial`; signing and update channels | Guard |
| `node-addon-system-release.yml` | `workflow_dispatch` | Secret `NPM_TOKEN` and environment `npm-publish` for the `@deepseek-ai` scope | Guard |
| `node-addon-system.yml` | `pull_request` and `push` to `master`, by path; `workflow_dispatch` | None; GitHub-hosted runners | Keep |
| `pi-ai-provider-e2e.yml` | `workflow_dispatch` | Secrets `ANTHROPIC_API_KEY_EXTERNAL` and `AZURE_OPENAI_API_KEY_EXTERNAL` for paid provider calls | Guard |
| `pr-check-after-approve.yml` | `pull_request_target`, `pull_request_review` | GitHub App secret `DSH_APPROVAL_APP_PRIVATE_KEY`; upstream's `Policy` checks | Guard |
| `pr-check-on-base-branch.yml` | `push` to `master`, `workflow_dispatch` | Secret `DSH_RECHECK_LABEL_TOKEN`; upstream's `deepseek-harness-check` action | Guard |
| `pr-check-on-head-branch.yml` | `pull_request_target` | Upstream's `deepseek-harness-check` action; a Blacksmith runner | Guard |
| `publish-ssh-helper.yml` | `workflow_dispatch` | Publishes GitHub Releases for upstream's `dsh-v` tags | Guard |
| `python-release.yml` | `workflow_dispatch` | PyPI environments `pypi` and `pypi-runtime`; variables `PYPI_PUBLISHER_REPOSITORY` and `PUBLIC_PYPI_RELEASE_ENABLED` | Guard |
| `release-publish.yml` | `workflow_dispatch` | Secret `NPM_TOKEN` and environment `npm-publish` for the `dsh` release sequence | Guard |
| `release-vendor-publish.yml` | `workflow_dispatch` | Secret `NPM_TOKEN` and environment `npm-publish` for the vendor sequence | Guard |
| `release-vendor.yml` | `pull_request`, `push` to `master`, `workflow_dispatch` | None; the pack needs no credential. The self-hosted route applies only when the failover variable is set | Keep |
| `release.yml` | `pull_request`, `push` to `master`, `workflow_dispatch` | None; the pack needs no credential. The self-hosted route applies only when the failover variable is set | Keep |
| `sandbox.yml` | `push` to `master` | None; GitHub-hosted images. The trigger names `master`, which Delo does not use | Keep |
| `weighted-approval-review-event.yml` | `pull_request_review` | None; records the review event that `weighted-approval` reads | Keep |
| `weighted-approval.yml` | `pull_request_target`, `issue_comment`, `workflow_run` | GitHub App secret `DSH_APPROVAL_APP_PRIVATE_KEY`; variables `DSH_APPROVAL_APP_CLIENT_ID` and `DSH_APPROVAL_APP_SLUG` | Guard |
| `windows-package.yml` | `workflow_dispatch` | Self-hosted runner `dsh-win-package-trial` with the signing configuration | Guard |

`ci.yml` and `ci-windows.yml` need no secret, so they are kept. Each job keeps upstream's runner expression as the branch that applies in upstream's repository, where DeepSeek's runner labels such as `dsh-ubuntu-24-04-16core` and `dsh-windows-2025-16core` stay in use. Every other repository runs the job on `ubuntu-latest` or `windows-latest`, so this repository never waits for a DeepSeek runner. Each file has a `delo-feature` ledger entry for this routing.

The self-hosted route in `release.yml` and `release-vendor.yml` is guarded by `github.repository == 'deepseek-harness/deepseek-harness'`, which names a different organisation from the upstream repository in the ledger. The route applies only when the failover variable is set, so Delo does not reach it; the guard's organisation name is left as upstream wrote it.

## Local checks

The check runner, `delo/apps/tools/src/run-checks.ts`, arrives with WP1.10. Until then, these commands run from the repository root:

- `pnpm --filter @delo/tools check` runs the ledger checks above and exits 1 on any violation.
- `node_modules/.bin/tsx delo/apps/tools/src/check-fork-boundary.ts --count` runs the same checks and prints the divergence count.
- `node_modules/.bin/tsx delo/apps/tools/src/checks/gates/<name>.ts` runs one gate in the table above, with `<name>` the gate's file name, such as `licence`. The range gates take `--base <rev>`.
- `node_modules/.bin/vitest run --config delo/vitest.config.ts` runs the specs under `delo/apps/*/tests` and `delo/packages/*/tests`.
- `node_modules/.bin/tsc -p delo/apps/tools/tsconfig.json --noEmit` typechecks this package.

The [delo-dev-workflow skill](../../../.agents/skills/delo-dev-workflow/SKILL.md) states when to run each check.

## Reconciliation against rc.1

This tree was reconciled against `dsh-v0.2.2-rc.1`, the commit the ledger pins.
Each line names the file, its disposition number in the upstream disposition report, the disposition, and what was kept or deferred.
A deferred hunk waits for the package that owns its feature; a referent is an identifier, package or path that the hunk names.

- `pnpm-workspace.yaml`: disposition 0, applied, class `security`. All four hunks are kept: the `delo/apps/*` and `delo/packages/*` globs, the `!delo/apps/docs` exclusion, the passkey ASN.1 override, and the `allowBuilds` entries.
- `pnpm-lock.yaml`: no disposition entry. The override record and this package's importer are kept; regenerate the lockfile with `pnpm install` on an upstream merge.
- `scripts/verify-export-jsdoc.ts`: disposition 6, applied. The scope parameter is kept.
- `scripts/gen-third-party-notices.ts`: disposition 235, applied in part. Hunks 2 and 3 are kept, so the notices read the members that pnpm installs and skip the members it excludes with `!`. Hunk 1, the `ssh2` license override, is deferred to the package that brings `ssh2`; no package in this tree depends on it.
- `scripts/gen-third-party-notices.spec.ts`: disposition 409, applied. Both hunks are kept.
- `scripts/verify-repository-references.ts`: disposition 251, re-derived narrowly. The `pnpm-lock.yaml` exclusion is kept, and so is the exemption of the pinned `upstream.commit` field in the ledger. The broader `delo/` prefix is not carried, so every other `delo/` file stays scanned, and the `uv.lock` exclusion is not carried, because upstream's own spec scans that file.
- `scripts/verify-repository-references.spec.ts`: with disposition 251, two cases cover the exemptions.
- `scripts/test-non-loopback-address.ts`: disposition 449, re-derived. The link-local exclusion and the IPv6 loopback probe are kept. The Web e2e file that imports the probes, `apps/cli/tests/profiles/web/tests/public-url.expected.e2e.ts`, is not changed here, so the new IPv6 loopback probe has no caller in this tree until that file is reconciled.
- `scripts/test-non-loopback-address.spec.ts`: disposition 450, re-derived. Both hunks are kept.
- `scripts/types/client-assets/index.d.ts`: disposition 548, applied. The `*.woff2` declaration is kept.
- `ROADMAP.md`: added by Delo's base, with no disposition entry. It has a ledger entry only.

Deferred, not carried:

- `scripts/translation-pairing.manifest.json` (disposition 250): its `delo/` exclusion would exclude the Delo documentation pairs that the pairing gate requires, and the gate reports every such pair as a violation.
- `scripts/verify-concrete-terms.ts` (disposition 252): its `delo/apps/tools/catalogue/` exclusion names a directory this tree does not have.
- `scripts/gen-cordis-catalog.ts` (disposition 22): all seven hunks wait. Hunks 1, 2, 3 and 7 are the doctor, pluginAudit, profile-history and config-editor rows, which the referent rule defers. Hunk 4 names the agent-team type `TeamMemberModel`, hunk 6 names `PresetExtension`, and hunk 5 names `ProjectionRegistrationListener`; none of these is defined in rc.1.
- `scripts/type-equiv.manifest.json` (disposition 101): all three hunks wait. They name the agent-team types `TeamMessageView`, `TeamMessageRecord`, `TeamMemberModel` and `TeamMemberModelRecord`, and the type `ProjectionRegistrationListener`, which rc.1 does not define.
- `scripts/gen-doc-graphs.ts` (disposition 253): the `pluginAudit` row waits for the package that defines the audit seam. The disposition marks the row for the security pass.
