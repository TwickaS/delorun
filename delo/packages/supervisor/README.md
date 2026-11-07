---
description: "The @delo/supervisor package, for maintainers of the home process and the Docker runtimes: Delo's Docker supervisor with its fixed-schema API on a socket under ~/.delo, the start-token check, supervisor roots, image checks against the verified release manifest, the capability report built by inspection, hardened workspace containers and its operational log."
---

# @delo/supervisor

English | [中文](README.zh.md)

## Summary

This package is the Docker supervisor of [contract C9](../../docs/contracts/c09-runtime-supervisor.md), the only Delo component that calls Docker. It runs as a separate process of the person's user, which the home process launches. It serves a fixed-schema API on `run/<profile>/supervisor.sock` under the Delo home and accepts a request only with the current home-process start's token ([C1](../../docs/contracts/c01-home-layout.md)). It builds the capability report by inspecting a probe container, resolves every workspace root against the roots file that only `delorun setup` writes, runs only images whose digests the verified release manifest lists, and logs to [C20](../../docs/contracts/c20-operational-logs.md)'s `supervisor-<profile>` surface through [`@delo/logs`](../logs/README.md). The contract's values and types come from [`@delo/contract-runtime-supervisor`](../contract-runtime-supervisor/README.md).

## Contents

- [Launching the supervisor](#launching-the-supervisor)
- [The socket and the token](#the-socket-and-the-token)
- [The API](#the-api)
- [Supervisor roots](#supervisor-roots)
- [Images and the verified manifest](#images-and-the-verified-manifest)
- [The capability report](#the-capability-report)
- [Workspace containers](#workspace-containers)
- [The operational log](#the-operational-log)
- [Not yet implemented](#not-yet-implemented)
- [Tests](#tests)

## Launching the supervisor

The home process ([C19](../../docs/contracts/c19-home-process.md)) owns the start token. At each start it writes the token to `run/<profile>/start-token` with `@delo/home`'s `writeProtectedFile`, then spawns `src/main.ts` with a pipe on file descriptor 3 (`LAUNCH_FD`) and writes one launch line to it with `encodeLaunch`:

| Field | Value |
| --- | --- |
| `v` | 1 |
| `home`, `profile` | the resolved Delo home and the CLI profile |
| `startId` | C1's start id of this start |
| `token` | this start's token |
| `manifest` | the `images` entries of the release manifest the home process verified for the running runtime |
| `imagePull` | `registry` to pull a listed image the engine lacks, by digest; `none` to use only images the engine holds |
| `logLevel` | the most detailed level the supervisor logs |

The token reaches the supervisor only through the pipe, never a command line or an environment variable. The pipe stays open while the start runs; when the home process closes it or dies, the supervisor closes its socket and exits, and the next start launches a new supervisor with the new token. Containers keep running across that restart. `Supervisor.start` runs the same supervisor in a process that already holds these values.

## The socket and the token

- The socket is the pathname socket `run/<profile>/supervisor.sock`, set to mode 0600 after it binds, in a run directory that must pass C1's 0700 check. A path over 103 bytes is refused with `SOCKET_PATH_TOO_LONG`. A socket left by an earlier supervisor of the profile is removed; any other file at the path is refused.
- Each connection carries one request line of at most 65,536 bytes, which must arrive within 5 seconds (`REQUEST_TIMEOUT`); a 33rd open connection is answered `BUSY`. The connection closes after its response line.
- `StartTokenCheck` compares the request's `token` with the current start's token through fixed-length digests in constant time. A missing, wrong or previous start's token, and a line that is not a JSON object, receive `UNAUTHENTICATED` and nothing else.
- The token is checked before the schema is read, so a caller without the token learns nothing about the API.
- `readStartTokenFile` reads the token file through C1's protected-file check, for `delorun` client commands.

## The API

`decodeRequest` checks an authenticated request against the closed schema of C9's `SupervisorRequest`: an unknown `op`, an unknown field at any depth, or a value outside its type or bound is refused with `SCHEMA_VIOLATION`, whose detail names the field and never its value. No field names an image, a Docker flag, a mount, an environment variable, a command, a device, a capability or a network. Operations on one workspace run in arrival order. Each response line has `ok`; a failure has C9's `error` code and a `detail`. A failure the supervisor did not expect closes the connection without a response line and is logged.

| `op` | Served |
| --- | --- |
| `capabilities` | the Docker part of the report and the availability of each shape; `refresh: true` inspects again |
| `workspace.create`, `.start`, `.stop`, `.remove`, `.inspect`, `.list`, `.egress` | S2 workspace containers, their networks and their egress proxy |
| `helper.start`, `s3.create`, `s3.start`, `s3.stop`, `s3.inspect` | refused with `SHAPE_UNAVAILABLE`: the S2 helper and the S3 container arrive with their shapes |

## Supervisor roots

`loadRootRules` reads `supervisor/roots.json` at the supervisor's start through C1's protected-file check; a missing file means no parent, so every root is refused. A record that is not `{"v":1,"parents":[...]}` with at most 16 parents, or whose parent is not stored as an existing canonical path or is one setup refuses, stops the start. Nothing in this package writes the file.

`resolveWorkspaceRoot` resolves the requested root with `realpath` and refuses with `ROOT_REFUSED` the filesystem root, the OS home directory, the Delo home, a path that contains it or lies inside it, a path that does not resolve, and anything that is not a directory the person owns. A root not strictly inside a parent is refused with `ROOT_NOT_UNDER_PARENT`. Roots are checked before any Docker call, so they are refused on a machine without Docker as well.

## Images and the verified manifest

The supervisor depends only on [C2](../../docs/contracts/c02-release-manifest.md)'s types: it takes the verified manifest as the `VerifiedManifest` input, whose `images` the home process sends at launch after the release verifier has checked the manifest. Verifying a signature, a timestamp or a log entry is not this package's job, and no request names an image.

- `listedImage` takes C9's repository at the engine platform's digest, and refuses with `IMAGE_NOT_IN_MANIFEST` an entry naming another repository or a platform without a digest.
- `ensureListedImage` looks the image up as `<repository>@<digest>`, pulls exactly that reference when it is absent and `imagePull` is `registry`, and refuses with `IMAGE_NOT_IN_MANIFEST` an absent image when pulling is off, a failed pull, and an image whose recorded digests include none the manifest lists. Containers are created from that reference only, never a tag.

## The capability report

`inspectDocker` resolves the active Docker context as the `docker` command does (`DOCKER_HOST`, `DOCKER_CONTEXT`, the configuration's `currentContext`), reads the engine's `info` and `version`, and creates a probe container from the S2 image's listed digest with the Small preset on an internal network of its own. It reads the container's inspect record and runs fixed probe commands in it as execs whose exit code alone is read. A limit is `enforced` only when both show it:

| Limit | Inspected | Confirmed inside the container |
| --- | --- | --- |
| `cpu`, `memory`, `pids` | `NanoCpus`, `Memory` and `MemorySwap`, `PidsLimit` | the cgroup's quota and limits |
| `disk` | `StorageOpt.size`; an engine that refuses it gives `not-enforced` with its message | the root filesystem's size is within the limit |
| `cap-drop`, `no-new-privileges`, `seccomp` | `CapDrop`, `SecurityOpt`, the engine's seccomp option | `CapEff`, `NoNewPrivs` and `Seccomp` in `/proc/self/status` |
| `read-only-root`, `user-namespace` | `ReadonlyRootfs`, the engine's `userns` or `rootless` option | `/` mounted read-only; a `uid_map` that is not the identity |
| `network-isolation` | the probe network is internal and the container's only network | no default route on an interface other than `lo` |
| `host-gateway-block`, `host-loopback-block` | | connects to a listener the supervisor opens on the gateway address, and to a loopback listener through `host.docker.internal`, `10.0.2.2` and the gateway, all fail |
| `egress-allowlist` | | `unknown`: the probe needs the S2 image's egress proxy |

A probe tool that is missing or does not finish gives `unknown`, and so does a gateway address the supervisor cannot listen on, which is the case when the engine runs in a VM. The probe container and its network are removed before the report returns, whatever happened. `shapesOf` offers a shape only when C9's required limits are `enforced` and its image is listed; S2 is never offered on Docker Desktop, on any host system, because its helper sockets cannot cross Desktop's VM file sharing, and file watching is reported `supported` only on a Linux engine.

## Workspace containers

`workspace.create` resolves the root, checks the preset against the engine's machine (`PRESET_OUT_OF_RANGE`), makes the S2 image present, requires S2 to be offered and creates, under the home's and profile's labels:

- the internal network `delo-ws-<12 hex>`;
- the container of that name, built by `createBody`: every capability dropped, `no-new-privileges`, the engine's seccomp profile kept, a read-only root with a tmpfs `/tmp` of the preset's size, the preset's CPU, memory and PID limits with swap equal to memory, the disk size where the report found it enforced, an init process, no restart policy, no device, none of the host's namespaces, the workspace user of C9's helper channel, and bind mounts of only the resolved root (at the same path) and the helper's socket directory `run/<profile>/s2/<12 hex>/` at `/run/delo-helper`;
- unless egress is `none`, the egress proxy `delo-ws-<12 hex>-proxy` from the same digest on `delo-ws-<12 hex>-out` and the internal network, started with the entry `EGRESS_PROXY_ENTRY` and its mode and hosts in `DELO_EGRESS_MODE` and `DELO_EGRESS_HOSTS`.

After creating each container the supervisor compares its inspect record with its body (`hardeningDifferences`); a mount that differs from the resolved paths removes everything created with `ROOT_REFUSED`, and a setting the engine did not apply with `LIMITS_MISSING`. The workspace container's proxy variables always name the proxy, so under `none` nothing resolves and nothing leaves. An operation on a container without this home's and profile's labels fails with `NOT_FOUND`. `workspace.remove` removes the containers, both networks and the helper directory and leaves the workspace root untouched.

## The operational log

`openSupervisorLog` opens `logs/supervisor-<profile>/supervisor.log` with the start id, and the process registers its token with the log's redactor before anything is logged. Each request writes one record with the operation, the workspace id and the outcome; a refused authentication is logged without the presented value, and no record carries a request body, a credential or an environment value. `captureSupervisorOutput` routes the process's own standard output and standard error into the same log. C20's cross-surface denial suite runs over this surface through the driver in `tests/log-driver.ts`.

## Not yet implemented

- The S2 helper (`helper.start`), the S3 container (`s3.*`) and credential forwarding are refused with `SHAPE_UNAVAILABLE` until their shapes add them.
- The egress proxy program is the S2 image's; until the image ships it, the proxy container does not start, and `egress-allowlist` is reported `unknown`.
- The seccomp profile C9 says the release ships is not listed in C2's manifest, so containers keep the engine's default profile, which is never disabled.
- Windows named pipes with C1's DACL: the supervisor listens only on a Unix socket.

## Tests

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/supervisor` runs the specs that need no Docker engine: the socket, framing and token checks, the closed schema, the root refusals, the launched process, the pure parts, and the confinement specs. `node_modules/.bin/vitest run --config delo/vitest.docker.config.ts delo/packages/supervisor` runs the Docker specs (`*.docker.spec.ts`) against the active context's engine with a stand-in S2 image built from `tests/fixtures/s2-image` and tagged under C9's repository name for the run; every container, network and tag they create is removed afterwards.

The confinement specs run each sandbox dialect the host provides through upstream's sandbox provider. A dialect whose profile does not yet express C1's `home-read` rule, found by a probe that reads a fixture under the home, is reported skipped with that reason, as is Landlock where its launcher is not usable. One spec applies C1's bwrap mechanism as the contract states it, to show that the socket and the token file lie where that mechanism hides them.
