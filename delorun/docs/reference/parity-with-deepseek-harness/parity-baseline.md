# Parity baseline

English | [中文](parity-baseline.zh.md)

This page records the parity baseline: upstream DeepSeek Harness's own test suites, run on Delorun's reference host at the upstream tag `dsh-v0.2.2-rc.1`. It holds two passes, a Node 24 check, the classification of each failure that remains, and the environment and host state those results depend on. It also records the green base on `main`: the procedure, its prerequisites, its one exclusion and the fixes that made each failing file pass. Terms follow the [Delorun glossary](../glossary.md).

## Contents

- [Reference host and tree](#reference-host-and-tree)
- [Passes](#passes)
- [Environment as upstream CI sets it](#environment-as-upstream-ci-sets-it)
- [Node 24 check](#node-24-check)
- [Classification of the remaining failures](#classification-of-the-remaining-failures)
- [Host state](#host-state)
- [Green base on main](#green-base-on-main)

<a id="reference-host-and-tree"></a>
## Reference host and tree

- **Tree.** The tree is upstream's tag `dsh-v0.2.2-rc.1`, checked out unmodified. Neither pass edited or committed it; afterwards only git-ignored build output differed.
- **Host.** Ubuntu 24.04.1 LTS on WSL2, kernel `6.6.87.2-microsoft-standard-WSL2`, 22 CPUs, 15 GiB memory and 4 GiB swap.
- **Tools.** pnpm 11.28.5, the version `package.json` pins. Playwright 1.61.1. Docker server 29.9.2, reachable.
- **Node.** Passes 1 and 2 ran Node `v26.12.1`. The Node 24 check ran Node `v24.22.0`.
- **Load.** Other jobs shared the host during both passes. The load average reached about 20 in pass 1 and about 25 in pass 2.
- **Prerequisites.** `pnpm install --frozen-lockfile` and `pnpm run build:native-system` passed. `pnpm exec playwright install chromium webkit`, run in `apps/web`, passed and reported the missing WebKit libraries described in [Host state](#host-state). No system packages were installed. The snapshot suite needs built `lib/` output, so pass 1 ran it once before any build and it failed.

<a id="passes"></a>
## Passes

Pass 1 used the plain environment. Pass 2 first rebuilt with the CI variables, then ran each suite in turn with the variables in [Environment as upstream CI sets it](#environment-as-upstream-ci-sets-it), confined to Linux.

### Pass 1: plain environment

No CI variables, the default build profile, and the unmodified WSL environment.

| Command | Exit | Wall time | Test files passed / failed / skipped | Tests passed / failed / skipped | Peak RSS |
| --- | --- | --- | --- | --- | --- |
| `pnpm run test` | 1 | 643 s | 2514 / 44 / 23 (2581) | 52268 / 147 / 256 (52672; 1 expected fail) | 2.58 GiB |
| `pnpm run test:snapshot`, before any build | 1 | 115 s | 3 / 1 / 0 (4) | 74 / 165 / 2 (241) | 517 MiB |
| `pnpm run test:snapshot`, after the build | 0 | 151 s | 4 / 0 / 0 (4) | 239 / 0 / 2 (241) | 512 MiB |
| `pnpm run test:web`, includes a build of about 157 s | 1 | 3695 s | 214 / 12 / 4 (230) | 925 / 15 / 31 (971) | 4.76 GiB |
| `pnpm run test:expected` | 1 | 108 s | 21 / 3 / 0 (24) | 137 / 5 / 0 (142) | 521 MiB |

Solo reruns passed 34 of the 44 failing unit files and 1 of the 12 failing web files. The reruns indicate that these failures came from load on the shared host.

### Pass 2: as upstream CI sets it

Pass 2 first ran `DSH_TELEMETRY_DISABLED=1 DSH_BUILD_CLIENT_PROFILE=official pnpm run build`: exit 0, 49 s, 10 of 10 gates. The official profile recorded 366 client artifacts with 4 public values; the default profile recorded 2.

| Command | Exit | Wall time | Test files passed / failed / skipped | Tests passed / failed / skipped | Peak RSS |
| --- | --- | --- | --- | --- | --- |
| `pnpm run test` (`DSH_COVERAGE_TEST_TIMEOUT_MS=90000`) | 1 | 979 s | 2533 / 28 / 20 (2581) | 52394 / 37 / 240 (52672; 1 expected fail) | 2.60 GiB |
| `pnpm run test:snapshot` (`DSH_EXAMPLE_MODE=lib`) | 0 | 140 s | 9 / 0 / 0 (9) | 257 / 0 / 2 (259) | 528 MiB |
| `pnpm run test:web` (`DSH_SNAPSHOT=replay`, `DSH_BUILD_CLIENT_PROFILE=official`), includes a build | 1 | 4335 s | 216 / 10 / 4 (230) | 929 / 11 / 31 (971) | 2.87 GiB |
| `pnpm run test:expected` (`DSH_EXAMPLE_MODE=lib`) | 1 | 103 s | 21 / 3 / 0 (24) | 136 / 6 / 0 (142) | 522 MiB |

The snapshot suite runs 9 files in pass 2, against 4 in pass 1, because `DSH_EXAMPLE_MODE=lib` adds the five `apps/web/tests/*.snapshot.ts` files. Each failing file of pass 2 was then run alone three times with the same environment; the results are in [Classification of the remaining failures](#classification-of-the-remaining-failures).

### Changes between the passes

- The unit lane fell from 44 failing files to 28, and from 147 failing tests to 37.
- The web lane fell from 12 failing files to 10, and from 15 failing tests to 11. `context-menus.e2e.ts` and `smoke-real.e2e.ts` passed in pass 2; their pass 1 failures did not reproduce.
- The expected lane has the same three failing files, with 6 failing tests instead of 5.
- `spawn-runner.spec.ts` failed alone in pass 1 and passed in the pass 2 full run.

### Scenario counts

The counts are the scenario directories under `snapshots/` that contain a `snapshot.yml`.

| Group | Scenarios |
| --- | --- |
| session | 166 |
| web | 71 |
| sdk | 38 |
| acp | 9 |
| Total | 284 |

<a id="environment-as-upstream-ci-sets-it"></a>
## Environment as upstream CI sets it

Each variable below takes the value that the upstream workflow files give it for the command this baseline runs. No workflow file sets `DSH_SNAPSHOT` or sets `DSH_EXAMPLE_MODE` for the snapshot, expected or web commands; the gate definitions in `scripts/run-gates.ts` set those.

- `DSH_TELEMETRY_DISABLED=1`: the top-level `env` of `.github/workflows/ci.yml`, `sandbox.yml` and `e2e.yml`. Applied to every command in this baseline.
- `DSH_BUILD_CLIENT_PROFILE=official`: the "Run compatibility smokes" step of the `node-compat` job in `ci.yml`, and `build-exe-for-python-sdk.yml`. The build gates set it through `CLIENT_BUILD_PROFILE_SELECTOR` in `scripts/client-build-environment.ts`, which `ciBuildGate` and `ciArtifactBuildGate` in `scripts/run-gates.ts` use. Applied to the pass 2 build and to the build inside `test:web`.
- `DSH_COVERAGE_TEST_TIMEOUT_MS=90000`: the job `env` of `node-24-coverage` in `ci.yml`, and the "Unit tests (darwin parity)" step of `sandbox.yml`, which runs `pnpm run check:ci:unit`. Applied to `pnpm run test`.
- `DSH_EXAMPLE_MODE=lib`: `e2e.yml` sets it for `pnpm run test:e2e`, which this baseline does not run. The snapshot and expected gate definitions in `scripts/run-gates.ts` set it for `pnpm run test:snapshot` and `pnpm run test:expected`.
- `DSH_SNAPSHOT=replay`: the web snapshot gate definition in `scripts/run-gates.ts` sets it for `pnpm run test:web`.

Upstream's self-hosted-only variables, such as `DSH_COVERAGE_MAX_WORKERS`, `DSH_GATE_CONCURRENCY` and `DSH_WEB_SNAPSHOT_WORKERS`, resolve to empty strings on hosted runners. This baseline leaves them unset.

### WSL confinement

Each command ran under the Linux confinement that Delorun's check tooling applies on WSL, `confineToLinux` in `delorun/apps/tools/src/checks/machine.ts`. Upstream CI does not apply it. The shell's `PATH` lost the 44 entries under the Windows drive mount and kept 25, and these variables were unset: `WSL_INTEROP`, `WSL_DISTRO_NAME`, `WSLENV`, `WSL2_GUI_APPS_ENABLED`, `DISPLAY`, `WAYLAND_DISPLAY`, `PULSE_SERVER` and `NoDefaultCurrentDirectoryInExePath`. The variables were set in the shell for each command rather than in each test fork; the removed set is the same, so the suites see the same environment.

<a id="node-24-check"></a>
## Node 24 check

The `.nvmrc` pin is `24`, and `ci.yml` sets `PRIMARY_NODE_VERSION` to `'24'`. The check put Node `v24.22.0` first on `PATH`, with the CI variables and the confinement kept.

- `pnpm install --frozen-lockfile` passed: exit 0, 3 s. The native addon was rebuilt under Node 24 and loads with module version 137.
- `DSH_BUILD_CLIENT_PROFILE=official pnpm run build` passed: exit 0, 95 s, 10 of 10 gates.
- Upstream's `node-compat` matrix also runs Node `24.9` and `26`.

Each file below ran alone three times under Node 24 with the pass 2 environment. The table is a targeted comparison, not a full Node 24 pass, and it does not replace one.

| File | Node 24, 3 runs | Node 26, pass 2 | Result |
| --- | --- | --- | --- |
| `apps/web/tests/composer-focus.e2e.ts` | fails 3 of 3 with `llm-replay: fixture not fully consumed` at teardown | fails 3 of 3, same error | same failure on both |
| `apps/web/tests/context-meter.e2e.ts`, Chromium tests only (`-t Chromium`) | passes 3 of 3 | passes 3 of 3 | passes on both |
| `apps/cli/tests/profiles/headless/tests/subagent-diagnostic.expected.e2e.ts` | passes 3 of 3 | fails 3 of 3, catalogued child line missing | passes on Node 24 only |
| `apps/cli/tests/profiles/headless/tests/subagent-inheritance.expected.e2e.ts` | passes 3 of 3 | fails 3 of 3, `delegationDepth` differs | passes on Node 24 only |
| `apps/cli/tests/profiles/web/tests/public-url.expected.e2e.ts`, serving case | fails 3 of 3 with `HTTP request timed out` | fails 3 of 3, same error | same failure on both |
| `apps/cli/tests/profiles/web/tests/public-url.expected.e2e.ts`, plain-HTTP warning case | passes 1 of 3; fails 2 of 3 with `expected 'SIGKILL' to be undefined` | fails 3 of 3, same error | flaky on Node 24; same error when it fails |
| `packages/session/session-persistence-jsonl/tests/generation.spec.ts` | passes 3 of 3 | fails 3 of 3, zstd target bytes | passes on Node 24 only |
| `packages/subagent/subagent-acp/tests/subagent-acp.spec.ts` | passes 3 of 3 | passes 3 of 3 | same |
| `packages/subagent/subagent/tests/continuation.spec.ts` | passes 3 of 3 | passes 3 of 3 | same |
| `packages/experimental/liveshare/tests/viewer-source-write-unavailable-artifact.client.spec.tsx` | passes 3 of 3 | passes 3 of 3 | same |
| `packages/experimental/ptc-runtime-python/tests/runtime.spec.ts` | passes 3 of 3 | passes 3 of 3 | same |
| `packages/experimental/liveshare/tests/viewer-shell-artifact.client.spec.tsx` | passes 3 of 3 | passes 3 of 3 | same |

The last five rows are five files drawn at random from class (c) of the classification below.

Node 24 and Node 26 agree on `composer-focus.e2e.ts`, on the serving case of `public-url.expected.e2e.ts`, and on the Chromium cases of `context-meter.e2e.ts`. Three files fail only on Node 26.12.1 in this check: `subagent-diagnostic`, `subagent-inheritance` and `generation.spec.ts`. The plain-HTTP warning case of `public-url.expected.e2e.ts` is flaky on Node 24.

<a id="classification-of-the-remaining-failures"></a>
## Classification of the remaining failures

Pass 2's failing tests fall into four classes. A file's class follows from its solo runs and from the error its output shows. Each failing file belongs to one class, except `public-url.expected.e2e.ts`, whose IPv6 tests are in class (a) and whose other two tests are in class (d).

| Class | Meaning | Unit files | Web files | Expected files | Named failing tests |
| --- | --- | --- | --- | --- | --- |
| (a) | Host state: the WebKit system libraries or IPv6 loopback is missing on the host | 1 | 8 | 1 | 12 |
| (b) | Upstream test bug on WSL: the production WSL branch runs | 4 | 0 | 0 | 5 |
| (c) | Flaky under the full run: the file passes alone | 22 | 0 | 0 | not listed by test |
| (d) | Other: the cause is not diagnosed | 1 | 2 | 3 | 8 |

The expected column sums to 4 for 3 files because `public-url.expected.e2e.ts` is counted in classes (a) and (d). The web lane reports 11 failing tests in its total, but the named tests in classes (a) and (d) number 12 (9 WebKit tests, plus 3 in `composer-focus.e2e.ts` and `context-meter.e2e.ts`). This baseline does not resolve the difference.

### (a) Host state

WebKit browser launch fails because the host lacks WebKit's GTK and WPE system libraries. Eight web files fail at `browserType.launch` with the error that the host is missing dependencies to run browsers, 9 tests in all. Each fails 3 of 3 when run alone:

- `apps/web/tests/declared-reasoning.e2e.ts`
- `apps/web/tests/deepseek-messages-settings.e2e.ts`
- `apps/web/tests/markdown-wide-table.e2e.ts`
- `apps/web/tests/menu-material.e2e.ts`
- `apps/web/tests/models-settings.e2e.ts`, two tests
- `apps/web/tests/session-inspector.e2e.ts`
- `apps/web/tests/session-replay-reload.e2e.ts`
- `apps/web/tests/turn-tail-actions.e2e.ts`

IPv6 loopback is disabled on the host, so `::1` listeners fail with `EADDRNOTAVAIL`. Three tests fail this way, each 3 of 3 when run alone:

- `packages/test-support/llm-mock-server/tests/server.spec.ts`: "formats an IPv6 listener as a valid base URL" (unit).
- `apps/cli/tests/profiles/web/tests/public-url.expected.e2e.ts`: "prints the IPv6 loopback root for `::1` and serves it", and "prints the IPv6 loopback root for the second IPv6 spelling and serves it" (expected).

### (b) Upstream test bug on WSL

These tests do not inject the platform or the kernel release. The WSL2 kernel's release string contains `microsoft`, so the production WSL branch runs. Each file fails 3 of 3 when run alone.

- `packages/host/open-in-app/tests/resolver.spec.ts`: "does not offer the Linux file manager without a desktop session". The file never injects `osRelease`, and `isWsl()` in `packages/util/native-command/src/path-opener.ts` falls back to `os.release()`.
- `packages/util/native-command/tests/path-opener.spec.ts`: "rejects unsupported platforms, cancellation, and launcher errors", and "uses the native runner for a file-manager handoff when none is injected".
- `packages/util/native-command/tests/file-applications.spec.ts`: "uses the production command adapter and current platform when no override is supplied".
- `packages/util/native-command/tests/file-applications-linux-native.spec.ts`: "queries and launches an installed Linux desktop entry through GIO". The file injects no platform, so the WSL branch runs and calls `powershell.exe`, which the confinement removed.

### (c) Flaky under the full run

Twenty-two unit files fail in the full `pnpm run test` run and pass when run alone. Their first full-run error was a 30 s to 180 s budget timeout or a CPython probe timeout. Each passed 3 of 3 solo runs; the criterion is at least 2 of 3.

- `packages/client/ui-settings-account/tests/apply.client.spec.ts`
- `packages/experimental/client-ui-forge/tests/controller.host.spec.ts`
- `packages/experimental/worktree/tests/worktree.spec.ts`
- `packages/experimental/ptc-runtime-python/tests/runtime.spec.ts`
- `packages/experimental/speech-to-text-sensevoice/tests/worker.spec.ts`
- `packages/schedule/schedule/tests/change-notice.spec.ts`
- `packages/subagent/subagent/tests/continuation.spec.ts`
- `packages/subagent/subagent-acp/tests/subagent-acp.spec.ts`
- `scripts/gen-third-party-notices.spec.ts`
- `scripts/persistence-epoch-header.spec.ts`
- `scripts/persistence-schema.spec.ts`
- eleven files matching `packages/experimental/liveshare/tests/viewer-*.client.spec.tsx`

### (d) Other

The causes below were not diagnosed further. Each file fails 3 of 3 when run alone.

- `apps/web/tests/composer-focus.e2e.ts`: "keeps mobile submission keyboard navigation in the composer while retaining desktop focus" (1 test). The teardown reports `llm-replay: fixture not fully consumed`: one recorded script was never bound to a live session.
- `apps/web/tests/context-meter.e2e.ts`: "keeps details visible while resizing the window" for `Chat statistics: true` and `false` (2 tests). The teardown error is the same as in `composer-focus.e2e.ts`. The file launches WebKit, but the WebKit library gap does not explain these two tests.
- `apps/cli/tests/profiles/headless/tests/subagent-diagnostic.expected.e2e.ts`: "discovers a catalogued child without reading its descriptor through the assembled headless app" (1 test). The expected output lacks the catalogued child's line.
- `apps/cli/tests/profiles/headless/tests/subagent-inheritance.expected.e2e.ts`: "confines a delegated child through the assembled headless app" (1 test). The deep comparison differs in `delegationDepth`.
- `apps/cli/tests/profiles/web/tests/public-url.expected.e2e.ts`: "serves the bound address and a declared authority, refusing any other name" (`HTTP request timed out`), and "warns about the plain-HTTP bind even when an HTTPS root is advertised" (`expected 'SIGKILL' to be undefined`), 2 tests.
- `packages/session/session-persistence-jsonl/tests/generation.spec.ts`: "accepts a valid append on a zstd target created by another migration" (1 test). The append fails because the current session generation already exists and its target bytes do not begin with the migrated generation. No WSL-specific cause was found.

<a id="web-e2e-rc5"></a>
## Web e2e after the rc.5 drift fixes

The full web suite (`vitest.web.config.ts`) ran on the rc.5 branch with nothing else heavy beside it: 1,098 tests, 1,058 passed, 29 skipped and 11 failed in 11 files. After the fixes below, the 11 files plus the preview boot file passed on a rerun (16 files, 30 tests). The 29 skipped tests are the suite's own skips. The run showed no WebKit launch failure, so the WebKit entries of class (a) above do not apply to the web lane on the host that ran it.

| File | Class | Reason and resolution |
| --- | --- | --- |
| `built-boot.expected.e2e.ts`, `hmr-live.e2e.ts` | Build record | A preview build rewrote `dist/`, so the artifacts no longer matched `.dsh-build/client-build-environment.json`. A complete `pnpm run build` restored it; both pass. |
| `delorun-allow-for-chat`, `delorun-dangerous-mode`, `delorun-full-access-consent`, `delorun-pairing`, `delorun-privacy-consent`, `delorun-setup-versions`, `delorun-update-notice` | Build record | The Delorun plugin libraries (`@delorun/plugin-trash`) had not been built in the worktree. A complete build fixed them; all pass. |
| `chat-fold-opened-group.e2e.ts` | Flaky under load | A scroll step moved the wrong way only while the host was loaded; it passed 3 of 3 alone. |
| `ptc-round.e2e.ts` | Test support | The golden held a real command's wall-clock duration. The aria normaliser now replaces spaced seconds (`0.1 s`) with `{{duration}}`, and four goldens were refreshed. |

The rc.4 triage classes resolved as follows.

- **Stale goldens (Copy command button and duration):** `clickable-links-gallery`, `ptc-round`, `live-job-stream`, `plugin-install-registry`, `plugin-install-silent-failure` refreshed.
- **Delorun divergence, specs updated:** the key placeholder ("Paste your key") in `deepseek-messages-settings`, `models-settings`, `onboarding-native`, `onboarding-usable-provider`; the Plugins "History" button in `plugin-config`; the local fetch provider's description in `plugin-config`; a loopback page ignoring the browser's offline state in `lifecycle-chrome`; the hover-peek sidebar in `window-drag-coverage`; the hex app icon, the build-derived title and the Delorun icon set in `pwa-manifest`; the session cookie that plugin assets now require in `smoke-real`.
- **Regressions, fixed in product code:** `preview-boot` (the preview worker's `node:fs` lacked numeric open flags, the `fd` option of read streams, `readlink` and `rmdir`, which the hardened local file reader needs) and `deepseek-chat-import` (the upload route did not declare `application/octet-stream`, so the exact-route media-type gate refused the archive). Each has a changelog fragment.
- **Not a regression:** `sidebar-terminal`. The confined call is the changed-files card's `git rev-parse` under the `workspace-write` default; the spec now forbids any confinement of the terminal itself and allows the git probe. One run also failed a colour test in the same file and passed on rerun (flaky under load).

<a id="host-state"></a>
## Host state

- **WebKit libraries.** The reference host lacks WebKit's GTK and WPE system libraries, so WebKit launches fail in the class (a) files. Chromium resolves fully.
- **IPv6 loopback.** IPv6 loopback is disabled on the host, so `::1` listeners fail with `EADDRNOTAVAIL`.
- **Owner decision.** The owner deferred the host fixes for both items on 2026-11-06. The class (a) failures are host-state results, and this page records them as the host stands. [Issue #58](https://github.com/twickas/delorun/issues/58) tracks both fixes.
- **Load.** Other jobs shared the host during both passes, as described in [Reference host and tree](#reference-host-and-tree). The solo reruns of pass 1 and the class (c) files show load-dependent failures.

<a id="green-base-on-main"></a>
## Green base on main

The green base is `main` with upstream's unit suite, upstream's recorded-session replay and Delorun's full gate passing, and no known failure carried forward: a test that cannot pass is fixed, or excluded by name with its reason recorded here. The run below was taken on Node `v24.22.0` at one commit of `main`, the run's commit; the fixes were made on top of an earlier one.

### Procedure

On Node 24 (`nvm use 24`), after `pnpm install --frozen-lockfile`, with no other test suite running on the host:

```sh
DSH_BUILD_CLIENT_PROFILE=official pnpm check:full
env -u NoDefaultCurrentDirectoryInExePath DSH_TELEMETRY_DISABLED=1 DSH_BUILD_CLIENT_PROFILE=official DSH_COVERAGE_TEST_TIMEOUT_MS=90000 \
  pnpm run test -t '^(?!.*(?:mock LLM server wire behaviors formats an IPv6 listener as a valid base URL))'
DSH_EXAMPLE_MODE=lib node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts --only tests:snapshots --no-cache
```

- `pnpm run test` runs upstream's own script, `pnpm run build:native-system && vitest run`, and pnpm appends the `-t` argument to it. `pnpm run test -- -t …` forwards the `--` as well, vitest then reads the pattern as file filters, and the exclusion does not apply.
- Vitest matches `-t` against a test's full name joined with spaces, not against the `>`-separated form its listing prints.
- A file that fails in the full run is rerun alone. A failure that disappears alone is contention and is recorded under [Contention](#contention); a failure that stays is fixed or excluded.

### Prerequisites

Upstream's CI runs the suite through `pnpm run test`, which gives each spec the first, third and fourth settings below; the reference host's first green-base run called vitest directly and lacked them. The second comes from WSL: the Windows side passes `NoDefaultCurrentDirectoryInExePath` into Linux shells, and upstream's CI never sets it.

| ID | Setting | File that fails without it | Why the spec needs it |
| --- | --- | --- | --- |
| P1 | `npm_execpath` names the repository's pnpm | `apps/desktop/tests/macos-notarization-proxy.spec.ts`, 15 tests | The desktop packaging scripts the spec runs build the flock addon through the pnpm that `npm_execpath` names; without it they stop with `flock addon is not built`. |
| P2 | `NoDefaultCurrentDirectoryInExePath` unset | `packages/subprocess/subprocess-local/tests/spawn-runner.spec.ts`, 1 test | Upstream's Windows command lookup in `runner-launch.ts` reads the variable from the process environment on any platform and then leaves the current directory out of the search roots the spec expects. |
| P3 | pnpm 11.28.5, the version `packageManager` pins, first on `PATH` | `packages/boot/plugin-manager/tests/manager.spec.ts`, 1 test | The spec's fixture starts `pnpm`; the host's global pnpm 10.34.7 answers the build approval with `restart-required` where the pinned version fails it. |
| P4 | `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false` | `scripts/release/pack.spec.ts`, 1 test | pnpm 11 verifies a workspace's dependencies before `pnpm exec` and runs the fixture's `prepare` hook when they look stale, which the spec asserts does not happen. `pnpm run` sets `pnpm_config_verify_deps_before_run=false` for its script and the script's children. |

P4 is a lead decision for the reference host, made on 2026-11-07: the setting reproduces the value `pnpm run test` gives every upstream spec in upstream's CI, so it changes nothing the spec checks. The alternative, excluding `release pack CLI > does not broaden an empty parallel family to the whole workspace` by name, would carry a known failure.

The procedure above provides all four: `pnpm run test` gives P1, P3 and P4, and `env -u` gives P2. Delorun's check runner has no lane for upstream's whole unit suite; its lanes get the same settings. `checkEnvironment` in `delorun/apps/tools/src/checks/machine.ts` removes P2 with the other Windows-side variables for every check on WSL, and the runner reads P1, P3 and P4 from pnpm for any run that plans a check that runs pnpm or is marked `pnpmScript`, as `tests:upstream-changed` is ([tools README](../../../apps/tools/README.md#local-checks)).

### Results

| Suite | Result |
| --- | --- |
| `pnpm check:full` | 44 passed, 0 failed |
| Recorded-session replay through the check runner | 9 files; 260 tests passed, 2 skipped |
| Unit suite, `node_modules/.bin/vitest run` with the exclusion and without the prerequisites | 41 files failed, 2531 passed, 20 skipped; 88 tests failed, 52556 passed, 1 expected fail, 241 skipped; 2 unhandled rejections |

Each failing unit file was rerun alone. 26 files passed alone: their 38 failing tests are contention. 15 files kept failing, with 58 failing tests: 50 that failed in the full run and the rerun, and 8 that failed only in the rerun. The table gives each file's cause and fix.

| File | Class | Cause | Fix |
| --- | --- | --- | --- |
| `apps/desktop/tests/macos-notarization-proxy.spec.ts` | prerequisite | Without P1 | The procedure |
| `scripts/ci-workflow.spec.ts` | Delorun change | Delorun's repository guard and runner routing in `ci.yml`, `ci-windows.yml`, `ci-master.yml`, `ci-python.yml` and the release, approval and issue workflows | The spec reads guarded fields through `scripts/tests/delorun-repository-guard.ts` |
| `scripts/tests/ci-release-selfhosted.spec.ts` | Delorun change | Delorun's repository guard in `cua-helper-package.yml` and `release-publish.yml` | As above |
| `scripts/tests/ci-master-platforms.spec.ts` | Delorun change | Delorun's repository guard in `build-exe-for-python-sdk.yml`, `ci-python.yml` and `ci-master.yml` | As above; `serial-macos` in `ci-master.yml` returns to upstream's `if: false`, which needs no guard |
| `scripts/client-bundle-css.spec.ts` | Delorun change | Delorun's `.woff2` package-asset media type; the spec used `.woff2` as its unsupported asset | The spec uses `.woff` as the unsupported font |
| `scripts/verify-client-packages.spec.ts` | Delorun change | As above | The spec expects the `.woff2` specifier and keeps a `.woff` one uncollected |
| `scripts/translation-prompt.expected.spec.ts` | Delorun change | Delorun's rows in `docs/i18n/terminology.md`, which the assembled prompt embeds | The expected output is re-recorded with `DSH_SNAPSHOT=refresh` |
| `scripts/release/pack.spec.ts` | prerequisite | Without P4 | The procedure |
| `scripts/desktop-publish-workflow.spec.ts` | Delorun change | Delorun's repository guard in `desktop-publish.yml` | As for `ci-workflow.spec.ts` |
| `scripts/ci-compatible-selfhosted.spec.ts` | Delorun change | Delorun's runner routing in `ci.yml` | As for `ci-workflow.spec.ts`, plus a case that every failover mode runs on `ubuntu-latest` outside upstream's repository |
| `packages/subprocess/subprocess-local/tests/spawn-runner.spec.ts` | prerequisite | Without P2 | The procedure |
| `packages/boot/plugin-manager/tests/manager.spec.ts` | prerequisite | Without P3 | The procedure |
| `packages/subagent/subagent/tests/continuation.spec.ts` | contention | See [Contention](#contention) | None |
| `packages/experimental/client-ui-forge/tests/local-diff-safety.host.spec.ts` | contention | See [Contention](#contention) | None |
| `packages/experimental/client-ui-forge/tests/controller.host.spec.ts` | contention | See [Contention](#contention) | None |

Each upstream spec edit and the helper have a `delorun-feature` entry in the divergence ledger.

After the fixes, each of the 15 files ran alone once on Node `v24.22.0` with the prerequisites (`env -u NoDefaultCurrentDirectoryInExePath pnpm exec vitest run <file>`, with the variables of the procedure), and each passed: 800 tests in all, none failed. `server.spec.ts` with the exclusion passed 45 tests, with the excluded one skipped.

### Exclusion

One test is excluded by name: `mock LLM server wire behaviors > formats an IPv6 listener as a valid base URL` in `packages/test-support/llm-mock-server/tests/server.spec.ts`. It fails on every run alone with `Error: listen EADDRNOTAVAIL: address not available ::1`, because IPv6 loopback is disabled on the reference host ([Host state](#host-state)). The exclusion ends when the host fix lands; [issue #58](https://github.com/twickas/delorun/issues/58) tracks it and the WebKit libraries.

<a id="contention"></a>
### Contention

The host is shared with other agents' suites, so these results depend on the load at the time of the run.

- The 26 files that passed alone were rerun while at least one other vitest process was running.
- `packages/subagent/subagent/tests/continuation.spec.ts` and `packages/experimental/client-ui-forge/tests/local-diff-safety.host.spec.ts` each failed in the full run and in a rerun that started while other vitest processes were running. Run alone at the run's commit, each passed three times out of three (164 and 17 tests); run alone at the earlier commit, each passed once. The host's load average was between 7 and 15 during these runs. Neither fails, so there was nothing to bisect; no commit between the tag and `main` touches either package, and both files are in class (c) at the tag.
- `packages/experimental/client-ui-forge/tests/controller.host.spec.ts` had two failures in the full run, both of which passed alone, and one 90000 ms timeout in a rerun that started beside another vitest process. Run alone at the earlier commit, with four other vitest processes on the host, it passed 118 tests of 118. It is in class (c) at the tag.

## Where to go next

The [parity checklist](parity.md) records the status of each difference from stock DeepSeek Harness. The [harness feedback log](../harness-feedback.md) records problems met while running these suites. The [reference index](../README.md) lists the other developer pages.
