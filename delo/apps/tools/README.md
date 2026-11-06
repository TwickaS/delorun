# Delo tools

English | [中文](README.zh.md)

`@delo/tools` is Delo's fork tooling, a private package in `delo/apps/tools`.
It holds the divergence-ledger checker, which keeps every difference between this tree and its pinned upstream commit recorded, and the count of that difference.
It also holds the gates that check each change, the commit standard, and the inventory of upstream's workflows.
The check runner, [`src/run-checks.ts`](src/run-checks.ts), orders and runs those gates and the other local checks described below; the local stack and the other fork tools arrive with later work packages.

## Modules

- `src/fork-boundary.ts` holds the ledger schema, the matcher for fork-owned paths and globs, the boundary errors and the divergence total.
- `src/check-fork-boundary.ts` is the command-line gate. It reads the ledger, checks the repository against it, and prints the count with `--count`.
- `src/ledger-merge.ts` is git's merge driver for the ledger. It merges the entries by path, and the rules are in the divergence ledger section below.
- `src/check-commits.ts` is the commit standard: a Conventional Commits subject, a DCO sign-off, and a changelog fragment or a `Changelog: none (<reason>)` trailer. It checks one message with `--message <file>`, the form a `commit-msg` hook passes.
- `src/checks/types.ts` and `src/checks/gates/index.ts` describe each gate as one command that the check runner executes.
- `src/checks/gates/` holds the gate modules and their data: licence, secrets, personal data, infrastructure, DCO, documentation times and the documentation checks.
- `src/check-jsdoc.ts` applies upstream's JSDoc rules to every `src` tree under `delo/`.
- `src/run-checks.ts` is the check runner: the tiers, the selection, the report.
- `src/checks/` holds the check catalogue (`plan.ts`), the scheduler (`run.ts`), the machine budget (`machine.ts`), the pass cache (`cache.ts`) and the budgets (`budgets.json`).
- `src/git.ts` runs git for the modules and reports exit statuses.
- `src/issues/` turns maintainer-written work briefs into GitHub issues: `brief.ts` holds the fields, the rules and the issue body, `references.ts` the links and paths a brief may carry, `labels.ts` the label file, `gh.ts` the `gh` calls, and `issues.ts` the command line.
- `tests/` holds the specs. The ledger rules run against temporary git repositories, and `ledger-merge.spec.ts` also rebases branches through the merge driver in them. The gate specs plant one violation per gate in temporary trees, and the documentation specs run upstream's scripts on planted fixture trees. `checks.spec.ts` and `checks-cache.spec.ts` cover the runner's selection, tiers, budgets, pass cache and `--plan`.

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

[`src/ledger-merge.ts`](src/ledger-merge.ts) is git's merge driver for the ledger, and [`.gitattributes`](../../../.gitattributes) routes `delo/upstream-patches.json` to it. Each clone configures the driver once, and every worktree of that clone shares the setting:

```sh
git config merge.delo-ledger.driver 'node_modules/.bin/tsx delo/apps/tools/src/ledger-merge.ts %O %A %B'
```

Without the setting, git merges the ledger as text. With it, the driver merges entries by `path`. An entry that one side changed takes that side's version, and so does an entry that one side removed while the other side left it alone. An entry that both sides added or changed identically is kept once. `forkOwned` is the ordered union of both sides, `upstream` must match on both sides, and `$schema` merges as one entry does. An entry that the sides changed differently stays in conflict, including an entry that one side removed while the other changed it: the driver wraps only those entries in conflict markers, names each on standard error, and exits 1. It also exits 1, after writing the merge, when the result fails the ledger parser or the entry rules. `forkOwned` keeps an entry while either side still lists it, so an entry leaves the ledger only when both sides have removed it.

## The gates

[`src/checks/gates/index.ts`](src/checks/gates/index.ts) lists each gate as a command that the runner executes from the repository root. A gate passes when its command exits 0. A staged gate accepts paths as trailing arguments, which the runner appends at pre-commit. A range gate compares the commits from `origin/v5` to HEAD unless it is given `--base <rev>`.

| Gate | Staged | Refuses or checks |
|---|---|---|
| `gates:licence` | no | Every package under `delo/` declares MIT, and the root `LICENSE` is the MIT licence. |
| `gates:secrets` | yes | Token-shaped strings, private keys and secrets-file names, with secretlint's recommended preset and DeepSeek's key shape. A finding on a line that upstream holds word for word passes. |
| `gates:personal-data` | yes | The salted hashes of the personal-data patterns, in the lines that the staged changes and the range add, and in the Author, Committer and Signed-off-by lines of the range; postal addresses by shape in those lines and in commit messages. A postal address is a house number and a street word on one line, with a full UK postcode, or a US state abbreviation and ZIP code, after the street word on that line or anywhere on the next line. The plain patterns live only in `~/.config/delo/personal-data.txt`; `--rehash` regenerates [`personal-data.hashes.json`](src/checks/gates/personal-data.hashes.json) from that file and exits 1 when it is absent. |
| `gates:infrastructure` | yes | IPv4 addresses outside loopback, the unspecified and broadcast addresses, the RFC 5737 documentation ranges, the cloud metadata address `169.254.169.254` and the base addresses of the reserved IPv4 blocks (`10.0.0.0`, `100.64.0.0`, `169.254.0.0`, `172.16.0.0`, `192.168.0.0`, `224.0.0.0`); IPv6 addresses in the globally routable or unique-local blocks, outside the RFC 3849 documentation range, the cloud metadata address `fd00:ec2::254` and the base address `fc00::`; tailnet names other than `example.ts.net`; and cloud account IDs. Documented exceptions are listed by path and value in [`infrastructure.allowlist.json`](src/checks/gates/infrastructure.allowlist.json). |
| `gates:dco` | no | Every non-merge commit of the range has a `Signed-off-by` line whose name and email are the author's. |
| `gates:commits` | no | The commit standard over the range, with the changelog rule. |
| `gates:changelog` | no | Each commit of the range that changes a product file adds a changelog fragment under `delo/changelog/unreleased/` or carries a reasoned `Changelog: none` trailer, and every fragment there parses. |
| `gates:doc-times` | no | A line the range adds to a Markdown file under `delo/` carries no deadline, quarter, schedule estimate or promise of timing. |
| `gates:docs` | no | Upstream's bilingual-pair, word-budget, hard-wrap, relative-link and TypeScript-fence checks over `delo/docs/`. |

The [gates workflow](../../../.github/workflows/gates.yml) runs each gate on pull requests and on pushes to `v5` and `main`, and passes each pull request's base or each push's previous tip as the range. Its personal-data step checks the lines the range adds and the commit metadata against the committed hashes only.

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

## Brief issues

`src/issues/issues.ts` turns a briefs file into brief issues.
A briefs file is a JSON array of objects.
Each object holds the sixteen fields of the [brief template](../../../.agents/skills/delo-delegation/SKILL.md#write-the-brief) under their labels, and also a `title`, the `labels` that the issue carries and its `milestone`.
The issue form [`brief.yml`](../../../.github/ISSUE_TEMPLATE/brief.yml) asks for the same fields in the same order, and [`labels.yml`](../../../.github/labels.yml) defines the labels.

Run the tool from the repository root in one of three modes:

- `--input <briefs.json> --dry-run` validates the briefs and prints each issue body.
- `--input <briefs.json> --create --repo <owner/name>` validates the briefs and checks that `gh` is signed in as a maintainer of the repository. Then, for each brief, it creates the issue and locks it, or, when an issue with the same title exists, locks that issue if it is unlocked and skips it if it is locked.
- `--sync-labels --repo <owner/name>` creates or updates each label in `labels.yml` with `gh label create --force`.

```sh
node_modules/.bin/tsx delo/apps/tools/src/issues/issues.ts --input delo/apps/tools/tests/issues/fixtures/briefs.valid.json --dry-run
```

Every problem prints one line on standard error and exits 1 before any GitHub call.
A brief has a problem when:

- a field is missing, blank or unknown, or the file is not a non-empty JSON array of briefs;
- `Model` is not one of Haiku at medium, high or max effort, or Opus at medium or high effort, so Opus at max effort is refused;
- a link is neither an `https://` URL on github.com/Delo-Run/delo or docs.delorun.com nor a relative path that the repository tracks;
- a backticked path, whose first segment is a top-level directory of the repository, names no tracked file or directory, except in `You own`, where a new file or directory is allowed when its nearest existing parent directory is tracked;
- the text names `delo/docs/plans/`, the private plan directory, or a machine path such as one that starts with `/home/`, `/Users/` or `~/`;
- a label is not defined in `labels.yml`, the labels omit `brief`, or the brief carries a `kind/*` label, which belongs to pull requests;
- a field adds a Markdown heading to the body, two briefs share a title, or two issues already share a brief's title.

Paths are checked against `git ls-files`, so a file must be in the index before a brief names it outside `You own`.
A new path in `You own` is refused when its nearest existing parent directory in the working tree is not tracked.
The rendered body links each tracked path to its place on branch `v5` of the public repository: a file to its `blob` and a directory to its `tree`.
Links that the brief already carries are rewritten the same way.
Code spans that hold a command, and fenced code blocks, stay as written.
Create the labels and the milestone in the repository before `--create`, because `gh issue create` fails on a label or milestone that the repository does not define.

Known limits:

- `gh` 2.45 has no flag for the native Issue Type, so an issue that `--create` makes carries no Issue Type.
- Links point at branch `v5`, so a path that exists only on the brief's own branch resolves after that branch merges.
- The title check reads at most 1000 issues and refuses a listing that reaches that count.

The specs in `tests/issues/` run the tool in scratch repositories with a fake `gh` first on `PATH`, and no spec reaches GitHub.

## Local checks

[`src/run-checks.ts`](src/run-checks.ts) runs the local checks. The catalogue is [`src/checks/plan.ts`](src/checks/plan.ts), which selects checks by change and by package; [`src/checks/run.ts`](src/checks/run.ts) starts each check once its needs pass and its CPUs and memory are free; [`src/checks/machine.ts`](src/checks/machine.ts) sets the memory ceiling; and [`src/checks/cache.ts`](src/checks/cache.ts) serves unchanged checks from the pass cache. The repository gates come from [`src/checks/gates/index.ts`](src/checks/gates/index.ts), and the budgets from [`src/checks/budgets.json`](src/checks/budgets.json).

Each check has a budget, its resident memory at the peak and its CPUs, which the runner keeps inside the run's ceiling, and a tier, the invocations that select it: `pre-commit` runs over the staged paths, `changed` selects by change (`--changed` and the pre-push hook), and `full` is the full gate.

| Check | What it proves | Budget | Tier |
| --- | --- | --- | --- |
| `boundary` | Every difference from upstream is fork-owned or a listed patch ([`check-fork-boundary.ts`](src/check-fork-boundary.ts)) | 0.3 GiB, 1 CPU | `changed`, `full` |
| `gates:*` | Each of the eight repository gates in [`checks/gates/index.ts`](src/checks/gates/index.ts); a gate marked `staged` also runs in `pre-commit` | 0.5 GiB, 1 CPU each | `changed`, `full`; a staged gate also `pre-commit` |
| `whitespace:staged` | No whitespace error in the staged changes (`git diff --cached --check`) | 0.1 GiB, 1 CPU | `pre-commit` |
| `jsdoc` | Upstream's JSDoc rules over every export of the fork's `src` trees ([`check-jsdoc.ts`](src/check-jsdoc.ts)) | 1.5 GiB, 1 CPU | `changed`, `full` |
| `typecheck:upstream` | Upstream's incremental typecheck (`pnpm run typecheck`), whose declarations the fork's programs read | 2.5 GiB, 2 CPUs | `changed`, `full` |
| `typecheck:delo:<program>` | `tsc -p` over each Delo tsconfig, one check per program; `--only typecheck:delo` selects them all | 1 GiB, 1 CPU each | `changed`, `full` |
| `build:artifacts` | Upstream's runtime bundles, built only when one is missing or older than its sources (`pnpm run build:artifacts`) | 4 GiB, 4 CPUs | `changed`, `full`, when stale |
| `tests:fork` | Every spec under `delo/apps/*/tests` and `delo/packages/*/tests` ([`vitest.config.ts`](../../vitest.config.ts)) | 0.5 GiB per worker | `changed`, `full` |
| `tests:snapshots` | Upstream's keyless recorded-session replay (`pnpm run test:snapshot`) | 0.6 GiB per worker, 5 CPUs, alone | `changed`, `full` |
| `tests:upstream-changed` | The specs of each changed upstream package and, within 150 spec files, of its direct dependents ([upstream's `vitest.config.ts`](../../../vitest.config.ts)) | 0.6 GiB per worker, up to 8 workers | `changed` |
| `generate:native` | Upstream's native system addon (`pnpm run build:native-system`) | 1 GiB, 2 CPUs | none: `--only generate:native` |

The `pre-commit` tier runs within a budget of 5 seconds (`budgets.json`) and reports a run that exceeds it. The Docker lane, the built-package specs, the documentation site, the workflow checks and the Cordis check arrive with the packages that need them.

Commands, from the repository root:

```sh
pnpm check                       # --changed: what changed since v5, and the checks it needs
pnpm check:full                  # the full gate, with no pass cache
pnpm check -- --plan             # the selection with each reason, cache state, expected time and budget; runs nothing
node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts --list        # the whole catalogue
node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts --only tests:fork
node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts delo/apps/tools    # targets: that package's specs, and the typechecks of the packages that depend on it
```

Options: `--changed`, `--pre-commit` and `--pre-push` each select a tier, so give one; `--base <ref>` measures `--changed` from another ref (default `v5`); `--only` and `--skip` take check ids or groups (`boundary`, `gates`, `whitespace`, `docs`, `typecheck`, `tests`, `generate`), comma-separated; `--plan` and `--list` print without running; `--no-cache` skips the pass cache; `--bail` stops at the first failure; `--workers <n>` sets the fork suite's workers; `--no-scope` runs without the systemd user scope.

A check that declares its inputs passes once per key: the sha256 of the sorted list of its input files' git blob ids (the blob id of a tracked, unmodified file; the content hash of a modified, deleted or untracked one), the lockfile's blob id, the Node and pnpm versions, the command, its budget entry, and the values of the environment variables it lists. A stored pass with the same key is reported as `cached pass (<key prefix>)`, and the check does not run. The cache is off for `--no-cache`, `pnpm check:full`, a push with `DELO_FULL_GATE=1`, and when `CI` is set. A check without declared inputs always runs: the replay, the bundle build, the native addon and the staged whitespace check.

To install the hooks, write a one-line `lefthook-local.yml` at the root with `extends: [delo/lefthook.yml]` (git ignores it), then run `node scripts/install-lefthook.mjs`. The `pre-commit` hook runs the `pre-commit` tier. The `pre-push` hook runs `--pre-push`: what changed since the remote branch's tip, or, for a new branch, since its merge base with `v5`. `DELO_PUSH_SKIP=<check or group>,… git push` leaves checks out, and `DELO_FULL_GATE=1 git push` runs the full gate. The `commit-msg` hook runs `check-commits.ts --message <file>` on each commit message.

Reports and logs are under `node_modules/.cache/delo-checks/`: `report.json` holds each check's status, whether a cached pass served it, its reason, log, duration and peak memory; `logs/<check>.log` holds its full output; `pass/` holds the pass cache; `durations.json` holds each check's last duration, which orders the next run; `tsbuildinfo/` holds the incremental typecheck state. A machine-wide lock makes a second run wait for the first.

The ledger check alone is `pnpm --filter @delo/tools check`. One gate runs with `node_modules/.bin/tsx delo/apps/tools/src/checks/gates/<name>.ts`, such as `licence`, and the range gates take `--base <rev>`. The specs run with `node_modules/.bin/vitest run --config delo/vitest.config.ts`, and this package typechecks with `node_modules/.bin/tsc -p delo/apps/tools/tsconfig.json --noEmit`.

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
