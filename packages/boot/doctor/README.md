---
description: "The dsh doctor: run `dsh --profile doctor` to check the machine and composition dsh runs on, and register your own checks from any package."
kind: "package-bundle"
---

# @deepseek-ai/dsh-doctor

English | [中文](README.zh.md)

## Summary

`dsh-doctor` answers "will dsh work properly here?" in one command. `dsh --profile doctor` boots the shared base composition, runs every registered check, prints one line per check and a count, and exits 0 when none failed or 1 otherwise. Packages add checks through the `doctor` service, so a check lives beside the code it checks. The shipped checks cover the Node.js version and how completely the command sandbox confines a command under the deployment's mode.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Run it from the directory you would work in:

```sh
dsh --profile doctor
```

```text
ok    Node.js version: Node.js 24.9.0 is in the supported range >=24.9.0.
warn  Command sandbox: This machine enforces workspace-write only in part, such as on a kernel with an older Landlock ABI; a newer kernel enforces it in full.

1 passed, 1 warned, 0 failed
```

`ok` passed; `warn` works with less than it should; `FAIL` does not work, and its line says what to do. The profile initializes on first use from the shipped `doctor` template, the `dsh-base` bundle plus this package's bundle.

The app's `doctor` switch turns the run on. It is a validated Config field that defaults to off, which is Delorun's C16 parity value; the shipped `doctor` profile sets it on. An app mounted without the switch runs no check, writes one line to stderr and exits 1.

The sandbox check does not spawn the command it confines. It calls `confine` on a no-op command under the deployment's default mode and reads the enforcement. On Linux, the sandbox's first `confine` call runs its own functional probe, once per provider lifetime, which runs `true` under `bwrap` or the Landlock launcher to choose the runner.

### Add a check

A plugin that injects `doctor` registers a check for its own lifetime:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-doctor'

export const inject = ['doctor']
export function apply(ctx: Context) {
  ctx.doctor.register({
    id: 'my-cache',
    title: 'Cache directory',
    async run(signal: AbortSignal) {
      return { status: 'pass', detail: 'The cache directory is writable.' }
    },
  })
}
```

| Field | Default | Meaning |
|---|---|---|
| `checkTimeoutMs` | `10000` | How long one check may run before it is reported as failed |

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`DoctorRegistry` (`doctor`) keeps checks by id; `register()` is an effect of the calling plugin and refuses a used id. `run(signal)` runs every check concurrently, each under its own deadline, and returns one result per check in registration order: a check that rejects or outlives `checkTimeoutMs` is reported as failed with why, and cancelling the run's signal rejects the run. The `./checks` plugin registers the shipped checks; the sandbox check confines a no-op command under the `sandboxPolicy` default and reads the enforcement the sandbox reports. The `./app` plugin waits for `ctx.appReady`, prints the report on stdout and calls `ctx.appExit`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `DoctorRegistry`, `DoctorCheck`, `DoctorOutcome`, `DoctorResult` |
| [`src/checks.ts`](src/checks.ts) | The shipped Node.js and sandbox checks |
| [`src/app.ts`](src/app.ts) | The run-once app and its report |
| [`cordis.patch.yml`](cordis.patch.yml) | The bundle patch the `doctor` profile layers over `dsh-base` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-cmdline](../cmdline/README.md) — the launcher's exit request and readiness signal the app uses.
- [dsh-sandbox](../../sandbox/sandbox/README.md) — the enforcement the sandbox check reads.

-----

<a id="model-experience"></a>
## Model Experience

### Doctor run

#### What the model sees

None: the doctor runs outside any session, and no model sees its checks (`ctx.doctor`) or report.

#### Token effect

None; the doctor adds no content to any model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Two shipped checks** — other packages have not contributed theirs yet, so the doctor says nothing about credentials, storage or the Web server.
- **A check sees the base composition** — the `doctor` profile layers over `dsh-base` alone, so a check registered by another bundle runs only in a profile that mounts the registry and that bundle.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers, not shipped behaviour. Candidates for contributed checks: a credential for the default model route, a writable `DSH_HOME`, and the Web server's bind address.

</details>
