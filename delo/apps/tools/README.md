# Delo tools

English | [中文](README.zh.md)

`@delo/tools` is Delo's fork tooling, a private package in `delo/apps/tools`.
It holds the divergence-ledger checker, which keeps every difference between this tree and its pinned upstream commit recorded, and the count of that difference.
The check runner, the local stack and the other fork tools arrive with later work packages.

## Modules

- `src/fork-boundary.ts` holds the ledger schema, the matcher for fork-owned paths and globs, the boundary errors and the divergence total.
- `src/check-fork-boundary.ts` is the command-line gate. It reads the ledger, checks the repository against it, and prints the count with `--count`.
- `src/git.ts` runs git for both modules and reports exit statuses.
- `tests/` holds the specs. The ledger rules run against temporary git repositories, and the alias check reads the pinned upstream `tsconfig.base.json`.

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

## Local checks

The check runner, `delo/apps/tools/src/run-checks.ts`, arrives with WP1.10. Until then, these commands run from the repository root:

- `pnpm --filter @delo/tools check` runs the ledger checks above and exits 1 on any violation.
- `node_modules/.bin/tsx delo/apps/tools/src/check-fork-boundary.ts --count` runs the same checks and prints the divergence count.
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
