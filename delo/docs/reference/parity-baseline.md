# Parity baseline

English | [中文](parity-baseline.zh.md)

This page records the parity baseline: upstream DeepSeek Harness's own test suites, run on Delo's reference host at the upstream tag `dsh-v0.2.2-rc.1`. It holds two passes, a Node 24 check, the classification of each failure that remains, and the environment and host state those results depend on. Terms follow the [Delo glossary](glossary.md).

## Contents

- [Reference host and tree](#reference-host-and-tree)
- [Passes](#passes)
- [Environment as upstream CI sets it](#environment-as-upstream-ci-sets-it)
- [Node 24 check](#node-24-check)
- [Classification of the remaining failures](#classification-of-the-remaining-failures)
- [Host state](#host-state)

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

Each command ran under the Linux confinement that Delo's check tooling applies on WSL, `confineToLinux` in `delo/apps/tools/src/checks/machine.ts`. Upstream CI does not apply it. The shell's `PATH` lost the 44 entries under the Windows drive mount and kept 25, and these variables were unset: `WSL_INTEROP`, `WSL_DISTRO_NAME`, `WSLENV`, `WSL2_GUI_APPS_ENABLED`, `DISPLAY`, `WAYLAND_DISPLAY`, `PULSE_SERVER` and `NoDefaultCurrentDirectoryInExePath`. The variables were set in the shell for each command rather than in each test fork; the removed set is the same, so the suites see the same environment.

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

<a id="host-state"></a>
## Host state

- **WebKit libraries.** The reference host lacks WebKit's GTK and WPE system libraries, so WebKit launches fail in the class (a) files. Chromium resolves fully.
- **IPv6 loopback.** IPv6 loopback is disabled on the host, so `::1` listeners fail with `EADDRNOTAVAIL`.
- **Owner decision.** The owner deferred the host fixes for both items on 2026-11-06. The class (a) failures are host-state results, and this page records them as the host stands.
- **Load.** Other jobs shared the host during both passes, as described in [Reference host and tree](#reference-host-and-tree). The solo reruns of pass 1 and the class (c) files show load-dependent failures.
