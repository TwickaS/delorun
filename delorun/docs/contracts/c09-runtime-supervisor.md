---
description: "Contract C9: the runtime provider Service Definition and its capability report, the Docker shapes S2 and limited S3 with each shape's sandbox backend, container hardening, per-workspace networks and default egress, resource presets, credential forwarding, the fixed-schema Docker supervisor API with its socket and per-start token, supervisor roots, the S2 helper channel, the S2 and S3 images, and the container denial marker."
---

# C9 Runtime and supervisor interface

English | [中文](c09-runtime-supervisor.zh.md)

## Summary

This contract defines how a workspace chooses where its commands run, and the one Delorun component that talks to Docker. A runtime provider reports what the machine can isolate and enforce, and runs each workspace natively or in Docker in one of two shapes: S2, where each Docker workspace has its own container, and the limited S3, where one container isolates the computer but not the workspaces from each other. The Docker supervisor runs workspace containers only from image digests the verified release lists, under roots the person chose at setup, through a fixed-schema API on a socket under `~/.delorun` that accepts only the current home-process start's token; it never passes a request through to Docker. Each limit is reported as enforced only when inspecting the machine shows it. The types package [`@delorun/contract-runtime-supervisor`](../../packages/contract-runtime-supervisor/README.md) carries the interface, the schemas, the presets and the limits.

## Status

Nothing on this page is reached: no command or shipped profile runs a Docker workspace, and every workspace is native.

- **Built, reached by nothing:** `@delorun/supervisor`, with its fixed-schema API on the per-start token, its roots check, the capability report by probe container, the S2 workspace container with its hardening and internal network, and the image digest check. `delorun start` passes the home process no supervisor, so the home process never launches it, and nothing writes the supervisor's roots file. The container denial marker is built in upstream's sandbox, shell and PTC packages, and the sandbox's `containerDenialMarker` option is off by default and set by no shipped profile.
- **Not built:** the `delorunRuntime` provider and the `@delorun/runtime-docker` package; the S2 helper channel and every S3 operation, which the supervisor refuses with `SHAPE_UNAVAILABLE`; credential forwarding other than none, which the supervisor refuses; the egress proxy program in the S2 image; setup's Docker step, its list of limits and the rootless engine offer; the studio's runtime choice; the `workspace-isolation` check, which `delorun verify` reports as not run; the named pipes on Windows.

The requirements and denial tests below that this list names as not built or reached by nothing protect no one until a change builds and wires them. What a native workspace's commands can reach on each platform is [C1](c01-home-layout.md)'s subject.

## Contents

- [Status](#status)
- [The runtime provider](#the-runtime-provider)
- [The capability report](#the-capability-report)
- [Docker shapes](#docker-shapes)
- [Sandbox backend per shape](#sandbox-backend-per-shape)
- [Containers](#containers)
- [Networks and egress](#networks-and-egress)
- [Resource presets](#resource-presets)
- [Credential forwarding](#credential-forwarding)
- [The Docker supervisor](#the-docker-supervisor)
- [The supervisor API](#the-supervisor-api)
- [Supervisor roots](#supervisor-roots)
- [The S2 helper channel](#the-s2-helper-channel)
- [Images](#images)
- [The container denial marker](#the-container-denial-marker)
- [Limits](#limits)
- [Errors](#errors)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)
- [Enforcement per platform and dialect](#enforcement-per-platform-and-dialect)

## The runtime provider

The runtime provider is a Service Definition that the Delorun runtime packages register as the Cordis service `delorunRuntime`. One provider is active per Host; it serves every workspace of that Host.

- **Kinds.** A workspace runs as `native`, `docker-s2` or `docker-s3`. The Docker shape is a machine setting chosen in setup. Under S2, native or Docker is a workspace setting. Under S3, every workspace runs inside the one container, and the per-workspace choice is not offered.
- **Operations.** `report()` returns the [capability report](#the-capability-report). `resolve(request)` turns a workspace request into a complete specification: it fills the preset, the egress mode and the credential options from their defaults, explicitly, and rejects a request the report cannot satisfy. `start(spec)`, `stop(workspaceId, mode)` and `state(workspaceId)` manage the workspace's runtime. A Docker kind calls the supervisor for every Docker operation and never calls Docker itself.
- **Defaults.** A request without a preset resolves to Balanced, without an egress mode to `allowlist`, and without credential options to no forwarding.
- **Native workspaces.** The `native` kind runs commands on the machine with the person's own access, under upstream's sandbox and [C1](c01-home-layout.md)'s confinement rules, and reports [C1](c01-home-layout.md)'s rule states.
- **Routing.** Upstream's `fs`, `subprocess`, `sandbox`, `terminals`, `lsp` and `ptcRuntime` services are single-slot. The S2 package routes a Docker workspace's calls to its container through the seam it adds upstream; this contract fixes the provider's operations and the facts it reports, not that seam.

## The capability report

The report states what this machine runs and enforces. The supervisor builds the Docker part by inspection, at each supervisor start and whenever `capabilities` is called with `refresh`.

- **Fields.** `v` (1), `checkedAt`, `machine` (`os`, `arch`), `confinement` ([C1](c01-home-layout.md)'s rule states for native workspaces), `docker` (absent when no engine answers) and `shapes` (`s2` and `s3`, each `available` with a reason code when it is not).
- **The Docker part.** `engine` (`docker-engine`, `docker-desktop` or `other`), `version`, `rootless`, `context` (the active context's name), `endpoint` (`unix`, `npipe`, `tcp` or `ssh`, with its path), `storageDriver` and `limits`.
- **Limits.** Each entry of `limits` has a `status` (`enforced`, `not-enforced` or `unknown`) and an `evidence` string naming the inspected field and its value. The entries are `cpu`, `memory`, `pids`, `disk`, `cap-drop`, `no-new-privileges`, `read-only-root`, `seccomp`, `user-namespace`, `network-isolation`, `host-gateway-block`, `host-loopback-block` and `egress-allowlist`.
- **Inspection.** The supervisor creates a probe container from the S2 workspace image with the Small preset, reads its `docker inspect` record and runs probe commands inside it: a connect to a listener the supervisor opens on the network's gateway address, a connect to a host loopback listener, a request to a host outside the allowlist and a request to an allowlisted host. A limit is `enforced` only when the inspected record shows it and, for the network entries, the probe's forbidden connections fail while the allowed one succeeds. The probe network is created with the bridge driver's `isolated` gateway mode, so an engine that applies it gives the network no gateway address at all, and that absence is the evidence that `host-gateway-block` holds; an engine that ignores the option leaves the address in place and the connect decides. The probe container is removed afterwards.
- **Offering a shape.** Setup ([C11](c11-setup-answers.md)) lists every limit with its state on this machine before the person chooses a shape. S2 and S3 are offered only when `cap-drop`, `no-new-privileges`, `seccomp`, `network-isolation`, `host-gateway-block`, `memory` and `pids` are `enforced`. Any other entry that is not `enforced` is shown in setup and in the workspace's settings as advisory on this machine.
- **Shape reasons.** `docker-unavailable`, `docker-endpoint-network` (the context's endpoint is TCP or SSH), `s2-transport-unsupported` (Docker Desktop for macOS and Windows), `image-unverified` (the image digest does not match the verified manifest) and `limits-missing`.

## Docker shapes

| | S2 | S3, limited |
| --- | --- | --- |
| The harness runs | on the machine, as the home process | in the one container, as a separate user over a read-only tree |
| A Docker workspace runs | in its own container | in the one container, with every other workspace |
| Isolates | each workspace from the computer and from each other workspace | the computer from the workspaces, not the workspaces from each other |
| Native workspaces | stay available on the machine | none; the per-workspace choice is not offered |
| Reach | as configured | off; reach refuses to turn on |
| Engines | Linux engines, rootful or rootless | Linux engines and Docker Desktop |
| Image | the S2 workspace image | the S3 harness image |

- **The studio's label for S3** says that it isolates this computer from the agent's commands but does not isolate workspaces from each other.
- **S3's harness user.** The harness and the home process run as the user `delorun-harness` (uid 1001) inside the container. The container's root filesystem is read-only, so no user in the container can change the harness code. The Delorun home lies on a volume owned by `delorun-harness` with mode 0700. Workspace commands run as the user `delorun` (uid 1000), so they cannot read or change the home's secrets.
- **S3's privileges.** The harness keeps only `CAP_SETUID` and `CAP_SETGID`, to start commands as `delorun`, and every command it starts runs with an empty capability set and `no-new-privileges`.
- **S3's studio.** Inside the container the studio listens on a Unix socket in the container's run directory, which is bind-mounted from the machine's `~/.delorun/run/<profile>/s3/`. The machine's home process forwards its loopback listener to that socket, so the container publishes no port.
- **S3's host side.** On the machine, the home process holds [C1](c01-home-layout.md)'s lock and token and runs the supervisor and the loopback forwarding; the Host runs inside the container.
- **File watching.** The capability report states `fileWatching` per shape as `supported` or `unsupported` for this engine; where it is unsupported, the studio's file views refresh on request.

## Sandbox backend per shape

| Runtime | Commands run | Confinement | `workspace-write` | `read-only` | `danger-full-access` |
| --- | --- | --- | --- | --- | --- |
| Native | on the machine | upstream's dialect with [C1](c01-home-layout.md)'s rules | the dialect's write grant | the dialect | unconfined |
| S2 Docker workspace | in its container | the container | the container's writable set: the workspace root and `/tmp` | Landlock inside the container where it probes usable; otherwise `partial` enforcement | unconfined inside the container, which still confines it |
| S3 | in the one container | the container, and upstream's dialect inside it where it probes usable | the dialect, else the container's writable set | the dialect where it probes usable; otherwise `partial` enforcement | unconfined inside the container, which still confines it |

- Inside a container, bwrap cannot create namespaces with every capability dropped, so the container itself is the confinement. A sandbox mode inside a container can narrow what the container allows, never widen it.
- Additional writable roots are refused under S2 and S3 with `ADDITIONAL_ROOTS_UNSUPPORTED`, because the container mounts only the workspace root.

## Containers

Every workspace container and the S3 container run with these settings, and the supervisor refuses to start a container without them:

- every capability dropped (`--cap-drop ALL`), except S3's `CAP_SETUID` and `CAP_SETGID` for its harness;
- `no-new-privileges`;
- the seccomp profile that [C2](c02-release-manifest.md)'s manifest lists for the image (the `seccomp` file of its `ImageRef`), derived from Docker's default profile, when the manifest lists one, and otherwise the engine's default profile; never `unconfined`. A listed profile whose file does not match its length and digest refuses the container with `IMAGE_NOT_IN_MANIFEST`;
- a read-only root filesystem, with a tmpfs `/tmp` of the preset's size;
- the preset's CPU, memory and PID limits, with swap equal to memory;
- the preset's disk limit through `--storage-opt size` where the storage driver supports it, otherwise reported `not-enforced`;
- no Docker socket, no `--privileged`, no device, and none of the host's network, PID, IPC or user namespaces;
- the user that [the S2 helper channel](#the-s2-helper-channel) states, never the host's root;
- an init process, and no restart policy;
- the name `delorun-ws-<12 hex>` (the first 12 hexadecimal digits of the SHA-256 digest of the workspace id) or `delorun-s3-<profile>`, and the labels `run.delo.home` ([C1](c01-home-layout.md)'s `homeId`), `run.delo.profile`, `run.delo.workspace` and `run.delo.shape`.

## Networks and egress

- **One network per workspace.** Each Docker workspace has its own internal network, `delorun-ws-<12 hex>`, whose only members are the workspace's container and its egress proxy. No network has two workspaces as members, so no workspace container can reach another's. The proxy also joins a second network, `delorun-ws-<12 hex>-out`, which is its only route out.
- **Host gateway and loopback.** The internal network gives the workspace container no route to the machine, and it is created with the bridge driver's `isolated` gateway mode, so its bridge carries no host address and the container has no gateway to connect to. The proxy refuses destinations on the machine. `host.docker.internal` and the `host-gateway` alias are never added to a container.
- **The egress proxy.** It runs from the S2 workspace image's digest with the workspace's resource limits and the entry `/usr/local/bin/delorun-egress-proxy`, which the image provides. The supervisor passes the egress mode (`allowlist` or `open`) in `DELORUN_EGRESS_MODE` and the allowed hosts, comma-separated, in `DELORUN_EGRESS_HOSTS`. It is an HTTP proxy on port 3128 that serves `CONNECT` to port 443 and plain HTTP to port 80. It resolves each host itself and refuses a destination address that is loopback, link-local (`169.254.0.0/16`, `fe80::/10`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`), shared (`100.64.0.0/10`), multicast or the machine's own. The container's environment sets `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy` and `https_proxy` to the proxy; a tool that ignores them has no route out.
- **Egress modes.** `allowlist` (the default) allows the hosts below and the workspace's additions. `open` allows every public host and is set only by the person's choice for that workspace. `none` starts no proxy.
- **The default allowlist.** The hosts of the model providers configured in the profile; npm: `registry.npmjs.org`; PyPI: `pypi.org`, `files.pythonhosted.org`; crates.io: `crates.io`, `static.crates.io`, `index.crates.io`; the Go module proxy: `proxy.golang.org`, `sum.golang.org`; GitHub: `github.com`, `api.github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`, `release-assets.githubusercontent.com`.
- **Additions.** The person may add at most 64 hosts per workspace, each an exact host name or a `*.`-prefixed suffix, at most 253 characters. An IP address is not accepted as an addition. The runtime provider passes the hosts of the model providers configured in the profile as additions, within the same limit of 64.
- **S3.** The one container has the same internal network and proxy, with the same modes and allowlist.

## Resource presets

| Preset | CPUs | Memory | Disk | PIDs | `/tmp` |
| --- | --- | --- | --- | --- | --- |
| Small | 2 | 4 GiB | 20 GiB | 1,024 | 1 GiB |
| Balanced (default) | 4 | 8 GiB | 50 GiB | 2,048 | 2 GiB |
| Large | 8 | 16 GiB | 100 GiB | 4,096 | 4 GiB |
| Advanced | the person's values | the person's values | the person's values | the person's values | the person's values |

- **Advanced bounds.** CPUs from 1 to the machine's logical CPU count; memory from 1 GiB to the machine's memory minus 1 GiB; disk from 10 GiB to 1,024 GiB; PIDs from 256 to 32,768; `/tmp` from 256 MiB to half of the memory. A value outside its bound is refused with `PRESET_OUT_OF_RANGE`.
- **Presets above the machine.** A preset whose CPU or memory exceeds the machine is not offered on it.
- **Enforcement.** A limit that the capability report marks `not-enforced`, such as disk on a storage driver without quotas, is shown beside the preset as advisory on this machine.

## Credential forwarding

Forwarding is off for every workspace by default and is chosen per workspace. When a workspace forwards a credential, the studio states that the workspace's code can act as the person within that credential's scope.

| Option | What the container receives | Scope |
| --- | --- | --- |
| `deploy-key` | an ssh agent socket whose agent holds one key, for one repository | that repository's deploy-key rights |
| `agent-confirm` | an ssh agent socket whose agent holds the keys the person adds for this workspace, each added with `ssh-add -c` | each use asks for confirmation on the machine |
| `token` | `GH_TOKEN` and `GITHUB_TOKEN` in the container's environment | a fine-grained token limited to one repository |

- **Agents.** For `deploy-key` and `agent-confirm` the supervisor starts one ssh agent per workspace on the machine, with its socket in `~/.delorun/run/<profile>/agents/<12 hex>/`, and mounts that socket only into that workspace's container at `/run/delorun-agent/agent.sock`, with `SSH_AUTH_SOCK` set. Another workspace's container never receives it. The person's own agent is never forwarded.
- **Confirmation.** `agent-confirm` needs an askpass program on the machine to show each confirmation; where none exists, the option is not offered.
- **Storage.** A deploy key and a token are stored under [C1](c01-home-layout.md)'s `secrets/workspaces/<12 hex>/` with mode 0600. Neither is written to a log, a command line, the workspace root or the image.

## The Docker supervisor

The supervisor is the only Delorun component that calls Docker. It runs as a separate process of the person's user, never as root, from the runtime closure that the home process runs.

- **Lifetime.** The home process starts it when the machine is set up for Docker and passes it the start token over an inherited pipe. It stops with that home-process start, and a successor home process starts a new supervisor with the new token. Containers keep running across a supervisor restart.
- **Socket.** It listens on [C1](c01-home-layout.md)'s `run/<profile>/supervisor.sock`, or the named pipe [C1](c01-home-layout.md) names on Windows.
- **Callers.** It accepts a request only with the current start's token, compared in constant time; a missing, wrong or previous start's token receives `UNAUTHENTICATED` and nothing else. Its only caller is the home process. A workspace command never reaches it wherever [C1](c01-home-layout.md)'s `home-connect` rule is enforced, and under Landlock it can connect but cannot read the token.
- **Logging.** It writes the [C20](c20-operational-logs.md) surface `supervisor-<profile>`. It logs the operation, the workspace id and the outcome of each request, never a request body, a credential or an environment value.
- **Containers it manages.** It manages only containers that carry its home's and profile's labels; an operation on any other container fails with `NOT_FOUND`.

## The supervisor API

- **Framing.** Each connection carries one request, encoded as one line of UTF-8 JSON of at most 65,536 bytes, and the response lines that answer it. A request line must arrive within 5 seconds of the connection opening, and at most 32 connections are open at once.
- **Closed schema.** Every request has `v` (1), `token`, `op` and `args`. An unknown `op`, an unknown field or a value outside its type or bound is refused with `SCHEMA_VIOLATION`. No field carries an image reference, a Docker flag, a mount, an environment variable, a command, a device, a capability or a network name; the supervisor derives each of them from this contract.

| `op` | `args` | Effect |
| --- | --- | --- |
| `capabilities` | `refresh`: a boolean | returns the Docker part of the capability report |
| `workspace.create` | `workspaceId`, `root`, `preset` or Advanced `limits`, `egress`, `allowlistAdditions`, `credentials` | resolves and checks the root, creates the network, the proxy and the container from the S2 image's digest |
| `workspace.start` | `workspaceId` | starts the proxy and the container |
| `workspace.stop` | `workspaceId`, `mode`: `graceful` or `kill` | stops them; `graceful` waits at most 10 seconds before it kills |
| `workspace.remove` | `workspaceId` | removes the container, the proxy, both networks and the workspace's agent; the workspace root is untouched |
| `workspace.inspect` | `workspaceId` | returns the container's state, the limits in effect and the egress mode |
| `workspace.list` | none | returns the workspaces this supervisor manages |
| `workspace.egress` | `workspaceId`, `egress`, `allowlistAdditions` | changes the proxy's mode and additions |
| `helper.start` | `workspaceId` | starts the S2 helper and returns its channel key ([the S2 helper channel](#the-s2-helper-channel)) |
| `s3.create`, `s3.start`, `s3.stop`, `s3.inspect` | `stop` takes `mode` | manage the S3 container from the S3 image's digest |

- **Field bounds.** `workspaceId` is at most 128 characters; `root` is an absolute path of at most 4,096 bytes; `allowlistAdditions` is at most 64 host names.
- **Responses.** Each response line has `ok`; a failed line has `error` with a code from [errors](#errors) and a `detail` that names the refused value, never a secret.

## Supervisor roots

- **The roots file.** `supervisor/roots.json` ([C1](c01-home-layout.md), mode 0600) holds `{"v":1,"parents":["<absolute path>", ...]}` with at most 16 parent directories. Only `delorun setup` writes it, in the person's terminal; no Host API, tool or configuration row writes it. The supervisor reads it at its start.
- **Parents.** Each parent is stored as its canonical absolute path. Setup refuses `/`, the OS home directory, the Delorun home, any path that contains the Delorun home and any path inside it.
- **Workspace roots.** On `workspace.create` the supervisor resolves `root` with `realpath` itself. It refuses with `ROOT_REFUSED` a root that is `/`, the OS home directory or the Delorun home, that contains the OS home directory, that contains or lies inside the Delorun home, that lies inside or contains the root of another workspace container on the engine that carries Delorun's labels, whatever its home or profile, or that is not a directory owned by the person, and with `ROOT_NOT_UNDER_PARENT` a root that is not strictly inside one of the parents. Paths are compared by file identity, so an alias of a directory counts as that directory.
- **Before each start.** On every `workspace.start` the supervisor checks the workspace's containers again: each must carry its home's and profile's labels, the root mount's source must still resolve to itself and pass every rule above (`ROOT_REFUSED`), and every setting of [containers](#containers) must still be in effect (`LIMITS_MISSING`). A container that fails is not started.
- **Mounts.** An S2 container's bind mounts are the resolved workspace root, the workspace's helper socket directory and, when the workspace forwards an agent, that agent's socket. The S3 container's mounts are the resolved workspace roots, the volume that holds its Delorun home and the machine's `~/.delorun/run/<profile>/s3/`. No other host path is mounted. After creating the container, the supervisor compares the inspected mount sources with the resolved paths and removes the container with `ROOT_REFUSED` on any difference.
- **Who can change the roots.** Confined commands cannot write the file wherever [C1](c01-home-layout.md)'s `home-write` rule holds, and upstream's in-process file tools are limited to writable roots, which never include the home. A command or tool that runs under `danger-full-access` can write it.

## The S2 helper channel

Under S2, upstream's SSH helper inside each workspace container carries the workspace's file, process, terminal, LSP and PTC calls.

- **Helper.** The helper is upstream's `ssh-helper-runtime` executable, installed in the S2 workspace image, whose digest the harness checks as upstream's SSH connection checks `helperHash`.
- **User.** The supervisor starts the helper through Docker exec as the container's workspace user: the person's uid and gid on a rootful engine, and uid 0 on a rootless engine, which the engine maps to the person's uid on the machine. Workspace commands run as the same user. The helper never runs as a more privileged user than the commands it starts.
- **Transport on Linux engines.** The helper's directory, `~/.delorun/run/<profile>/s2/<12 hex>/` (mode 0700) on the machine, is bind-mounted read-only at `/run/delorun-helper`, and the harness connects to the sockets there. The one subdirectory the helper writes, `channel/`, is mounted writable at `/run/delorun-helper/channel`, and it may hold the helper's stream sockets and nothing else, so the one host path a workspace may add to holds no bytes of its own: at each start the supervisor removes a socket an earlier session left and refuses the start for any other entry.
- **Authentication.** At each helper start the supervisor generates a 32-byte channel key, writes it to the helper's standard input at exec, and returns it only in the `helper.start` response. The key is never written to a file, a command line or an environment variable. Every connection to the helper's sockets starts with the helper's 32-byte random challenge, which the harness answers with HMAC-SHA-256 over the challenge and the string `delorun-helper-v1` under the channel key. The helper closes a connection whose answer is wrong or does not arrive within 5 seconds.
- **What the key protects.** It refuses peers without the key: processes in other containers, which do not have the socket directory, and processes on the machine that reach the directory without the key. It does not protect the helper from commands in its own container, which run as the same user and are confined by the container.
- **Docker Desktop.** On Docker Desktop for macOS and Windows, S2 is not offered (`s2-transport-unsupported`).

## Images

| Image | Name | Base | Runs |
| --- | --- | --- | --- |
| S2 workspace | `ghcr.io/twickas/delorun-workspace-s2` | `docker.io/library/debian:bookworm-slim`, by digest | the helper, workspace commands and the egress proxy |
| S3 harness | `ghcr.io/twickas/delorun-harness-s3` | `docker.io/library/debian:bookworm-slim`, by digest | the harness with the runtime closure, workspace commands and the egress proxy |

- **Build.** Each image is built from its digest-pinned base within [C2](c02-release-manifest.md)'s reproducible-rebuild scope.
- **Signature and digest.** The release manifest ([C2](c02-release-manifest.md)) lists each image's digest, and the manifest's Ed25519 signature is the image's signature; no registry-side signature is trusted.
- **Pull.** The supervisor pulls only `<name>@sha256:<digest>` with the digest from the verified manifest of the running runtime, never a tag, and checks the pulled image's digest; a pull that fails is refused with `IMAGE_PULL_FAILED`. The pull reaches only `ghcr.io` and `pkg-containers.githubusercontent.com`.
- **Refusal.** The supervisor refuses to create a container from a digest that the verified manifest does not list, with `IMAGE_NOT_IN_MANIFEST`.

## The container denial marker

A file operation that a container's read-only root refuses is denied by the environment, and no sandbox mode lifts that denial. Its result therefore never offers escalation.

- **Signatures.** A Docker shape's sandbox wrap declares the environment's denial signatures in `ConfinedArgv.environmentDenialSignatures` of upstream's `@deepseek-ai/dsh-sandbox`: `read-only file system`.
- **Classification.** A failed run whose standard error matches only an environment signature is classified `deniedBy: 'environment'` by `denialOf`; a policy signature from `denialSignatures` outranks it.
- **The marker.** The result of an environment denial carries exactly the line `[sandbox: file access denied by the environment the sandbox runs in; no sandbox mode allows it]`, from `environmentDenialMarker()`, and no escalation hint; `denialMarkers` returns that line alone.
- **Executors.** The bash and PowerShell sandbox executors apply this classification and marker.
- **PTC.** The PTC executor applies it too: the Node PTC runtime's worker classifies a failed program against both signature sets, `run_code`'s result carries `sandbox.deniedBy: 'environment'`, and its rendering appends the environment marker in place of the policy sentence and its escalation guidance.
- **Native and parity.** Native runtimes declare no environment signatures, so the output of a native workspace and of the parity composition ([C16](c16-parity-composition.md)) does not change.

## Limits

| Limit | Value |
| --- | --- |
| Supervisor request line | at most 65,536 bytes |
| Time from connect to request line | 5 seconds |
| Open supervisor connections | at most 32 |
| `workspaceId` | at most 128 characters |
| `root` | at most 4,096 bytes |
| Supervisor parents | at most 16 |
| Allowlist additions per workspace | at most 64, each at most 253 characters |
| `graceful` stop before kill | 10 seconds |
| Helper channel key | 32 bytes |
| Helper challenge answer | within 5 seconds |
| Egress proxy port | 3128 |
| Presets and Advanced bounds | as [resource presets](#resource-presets) states |
| Protocol version `v` | 1 |

## Errors

| Code | Meaning |
| --- | --- |
| `UNAUTHENTICATED` | The request's token is missing, wrong or from a previous start |
| `SCHEMA_VIOLATION` | Unknown `op` or field, or a value outside its type or bound |
| `REQUEST_TIMEOUT` | No request line arrived within 5 seconds |
| `BUSY` | 32 connections are already open |
| `ROOT_REFUSED` | The root is `/`, the OS home or the Delorun home, contains the OS home, contains or lies inside the Delorun home, lies inside or contains another workspace's root, is not the person's directory, or its mount source differed after creation or no longer resolves to itself before a start |
| `ROOT_NOT_UNDER_PARENT` | The root is not strictly inside a setup parent |
| `IMAGE_NOT_IN_MANIFEST` | The image digest is not listed by the verified manifest, or the pulled digest differs |
| `IMAGE_PULL_FAILED` | Pulling a listed digest failed |
| `DOCKER_UNAVAILABLE` | No Docker engine answers at the active context |
| `ENGINE_REFUSED` | The Docker engine refused a call; the detail carries the engine's message |
| `WORKSPACE_EXISTS` | `workspace.create` named a workspace whose container already exists, or `workspace.start` one whose container already runs |
| `LIMITS_MISSING` | A limit that a shape requires is not enforced on this machine |
| `PRESET_OUT_OF_RANGE` | An Advanced value is outside its bound, or a preset exceeds the machine |
| `ADDITIONAL_ROOTS_UNSUPPORTED` | A Docker workspace was given additional writable roots |
| `SHAPE_UNAVAILABLE` | The requested shape is not available, with the report's reason |
| `NOT_FOUND` | The workspace or container is not one this supervisor manages |

## Consumers

- `delorun/packages/supervisor`: the supervisor, its API, the capability report, roots and image checks.
- `delorun/packages/runtime-docker`: the S2 shape, the S3 shape, credential forwarding and the Docker denial suite.
- The studio's workspace plugin: the runtime choice and the presets at workspace creation.
- `delorun/apps/release`: the S2 and S3 images and their digests in the manifest ([C2](c02-release-manifest.md)).
- `delorun/packages/integrity`: `delorun verify`'s isolation and Docker limit checks.
- Upstream's `packages/sandbox/sandbox`, `packages/shell/bash-sandbox`, `packages/shell/pwsh-sandbox`, `packages/ptc-runtime/ptc-runtime-node` and `packages/core/tool-executor-ptc`: the container denial marker.

## Compatibility

- The supervisor protocol version `v` and the capability report's `v` are 1. The supervisor and the home process come from the same runtime closure, so the protocol has no cross-version callers; a change still raises `v`.
- The preset names, the egress modes, the credential option names, the container and network names and their labels are external interfaces: workspaces created by one release are managed by the next. A change to any of them ships a migration in the supervisor and an upgrade guide under `delorun/docs/upgrade-guide/`.
- The roots file's `v` is 1; a supervisor reads every earlier version.
- The environment marker's text is model-visible and is kept as stated; changing it changes recorded Docker scenarios.
- The types package follows Delorun's version and changes in the same pull request as this page.

## Security

### Requirements

1. The supervisor's API has a fixed schema and is never a Docker passthrough: no request field names an image, flag, mount, environment variable, command, device, capability or network.
2. The supervisor socket lies under the home and accepts only the home process, by the current start's token ([C1](c01-home-layout.md)). The protection rests on [C1](c01-home-layout.md)'s confinement of the agent's commands; where a dialect cannot enforce it, `delorun verify` reports it and setup labels Docker mode. This contract claims no protection against a process of the person's user outside the sandbox, which can drive Docker directly when the person can. No root-owned helper exists.
3. Native sandbox profiles deny the Docker socket at its real path wherever the dialect enforces [C1](c01-home-layout.md)'s `docker-connect`.
4. Workspace roots lie under parents chosen at setup and stored in a file that only `delorun setup` writes. The supervisor resolves every path itself, refuses `/`, `$HOME` and `~/.delorun`, and mounts only the paths that [supervisor roots](#supervisor-roots) lists.
5. Each workspace has its own internal network shared with no other workspace, workspace networks have no route to the machine, and egress leaves only through the workspace's proxy with the default allowlist; `open` egress is set only by the person's choice.
6. Credential forwarding is off by default, chosen per workspace and limited to a deploy key, a confirming agent or a repository-scoped token; a forwarded agent reaches only its own workspace's container.
7. Setup recommends rootless Docker and states that membership of the `docker` group is equivalent to root on the machine.
8. Each enforced limit in the capability report is backed by inspection of a probe container; nothing is reported enforced from configuration alone.
9. Under S3 the harness runs as a separate user over a read-only tree, workspace commands run as another user without capabilities, and reach is off.
10. The S2 helper runs as the container's workspace user and accepts only peers that prove the channel key.
11. The supervisor runs only S2 and S3 images whose digests the verified release manifest lists, pulled by digest from `ghcr.io`.
12. An environment denial inside a container is never answered with escalation guidance, in the shell executors and in the PTC executor.
13. On a Landlock-only system whose active Docker context is a rootful engine's socket, `delorun verify` reports `docker-connect` as not enforced through the `workspace-isolation` and `confinement-rule` checks of [C15](c15-verification-checks.md), and setup names the socket's path, states that confined native commands can reach it and that this is equivalent to root, and offers Docker's rootless engine.

### Denial tests

| Test | Proves |
| --- | --- |
| `docker-from-native-denied` | On each dialect that enforces [C1](c01-home-layout.md)'s `docker-connect`, `docker ps` from a confined native workspace command fails |
| `supervisor-connect-denied` | On each dialect that enforces [C1](c01-home-layout.md)'s `home-connect`, a confined native workspace command's connect to the supervisor socket fails and it cannot read the start token |
| `supervisor-token-required` | A request without a token, with a wrong token and with the previous start's token each receives `UNAUTHENTICATED` |
| `supervisor-landlock` | Under Landlock, a confined native workspace command's connect to the supervisor socket succeeds and its request fails with `UNAUTHENTICATED`, because it cannot read the token, and `delorun verify` reports that state |
| `supervisor-not-enforced-labelled` | On a fixture dialect that cannot enforce [C1](c01-home-layout.md)'s rules, `delorun verify` reports them and setup's Docker mode option carries the label |
| `supervisor-schema-closed` | Requests with an image reference, a mount, an environment variable, a command or an unknown `op` are refused with `SCHEMA_VIOLATION`, and no container is created |
| `supervisor-roots-refused` | Roots `/`, `$HOME`, `~/.delorun`, a path containing `~/.delorun` or `$HOME`, a path inside or containing another workspace's root, a symbolic link resolving outside every parent and a path outside every parent are refused, and a workspace whose root no longer resolves to itself is not started |
| `supervisor-image-unlisted` | A container from a digest the verified manifest does not list is refused with `IMAGE_NOT_IN_MANIFEST` |
| `capability-report-inspected` | Each `enforced` limit in the report matches `docker inspect` of the probe container, and a limit the engine ignores is reported `not-enforced` |
| `cross-workspace-denied` | A workspace container cannot connect to another workspace's container or proxy |
| `host-loopback-denied` | A workspace container cannot connect to a host loopback listener or to a listener on its network's gateway address |
| `egress-allowlist` | A request to a host outside the allowlist and to a private address through the proxy fails, and a request to an allowlisted host succeeds |
| `agent-not-shared` | A workspace without forwarding, and another workspace, cannot use a workspace's forwarded agent |
| `helper-peer-refused` | A connection to the S2 helper's socket that does not answer the challenge with the channel key is closed |
| `s3-harness-readonly` | Under S3, a workspace command cannot write the harness tree or read or write the home's secrets, and reach refuses to turn on |
| `environment-denial-no-escalation` | Under S2, a write to the container's read-only root returns the environment marker and no escalation hint, through bash and through `run_code` |
| `landlock-rootful-docker-named` | On a Landlock fixture with a rootful Docker socket, `delorun verify` reports `docker-connect` as `not-enforced` with the socket's path, and setup's Docker step names that path, states the root equivalence and offers the rootless engine before Docker mode can be chosen |

### What this does not prove

- **Landlock with a rootful engine.** Landlock cannot deny a native command's connect to the Docker socket, so on a Landlock-only system with a rootful engine any confined native command can start a container with the machine's files mounted. Delorun reports it and offers the rootless engine; it cannot close it there.
- **Docker over the network.** A context whose endpoint is TCP or SSH is reachable by any command with network access, which no dialect confines; the report marks it `docker-endpoint-network`, and Docker shapes are not offered on it.
- **Host gateway and loopback.** The internal network's distance from the machine is the engine's: the network is created with the bridge driver's `isolated` gateway mode, and an engine that ignores the option is caught by the probe at inspection, not again at every workspace start. A machine that leaves the gateway reachable does not enforce `host-gateway-block`, and S2 is not offered on it.
- **Disk limits.** Most storage drivers, every rootless engine and Docker Desktop do not enforce a container's disk size; the preset's disk value is advisory there.
- **The helper key.** It does not protect the S2 helper from commands in its own container, which run as the same user.
- **S3.** S3 does not isolate workspaces from each other.
- **The roots file under full access.** A command or tool running under `danger-full-access` can change `supervisor/roots.json`.
- **Docker Desktop.** Containers run inside Docker Desktop's VM, which is not a user namespace for the container itself.

## Enforcement per platform and dialect

The capability report states each limit as inspected on the machine; this table states what each engine can provide.

| Limit | Linux engine, rootful | Linux engine, rootless | Docker Desktop for macOS | Docker Desktop for Windows |
| --- | --- | --- | --- | --- |
| S2 | offered | offered | not offered | not offered |
| S3 | offered | offered | offered | offered |
| `cap-drop`, `no-new-privileges`, `seccomp`, `read-only-root` | enforced | enforced | enforced, inside Docker Desktop's VM | enforced, inside Docker Desktop's VM |
| `cpu`, `memory`, `pids` | enforced with cgroup v2 | enforced only when cgroup v2 controllers are delegated to the person's user | enforced inside the VM | enforced inside the VM |
| `disk` | enforced only with a storage driver that supports `size`, such as overlay2 on XFS with project quotas | not-enforced | not-enforced | not-enforced |
| `user-namespace` | not-enforced unless the engine uses `userns-remap` | enforced | not-enforced for the container; containers run inside Docker Desktop's VM | not-enforced for the container; containers run inside Docker Desktop's VM |
| `host-gateway-block`, `host-loopback-block` | as the probe finds | as the probe finds | as the probe finds | as the probe finds |
| Socket denial for native commands | [C1](c01-home-layout.md)'s table | [C1](c01-home-layout.md)'s table | [C1](c01-home-layout.md)'s table | [C1](c01-home-layout.md)'s table |

- **Root equivalence.** On a rootful engine, any process that reaches the Docker socket can start a container with the machine's files mounted, so membership of the `docker` group is equivalent to root. A rootless engine runs containers with the person's own rights.
