---
description: "Contract C7: the reach provider Service Definition and its states, the visibility note each reach option publishes, the configuration rows, the Tailscale serve target with its current fallback and the socket variant a passing spike adopts, identity headers, Funnel on its own listener, own-domain reach with the CAA record Let's Encrypt enforces and the challenge rule, and the Delorun relay client as a fast-follow."
---

# Contract C7: reach providers

English | [中文](c07-reach-providers.zh.md)

<a id="summary"></a>
## Summary

A reach provider turns one reach option on or off: it connects a reach listener of [C4](c04-admission.md#listeners) to the outside and publishes what the provider of that option can see and do. Delorun 1.0 has three reach options: Tailscale private, Tailscale Funnel and the self-hosted relay on the person's own domain. None uses Delorun infrastructure. This page defines the provider Service Definition and its states, the visibility notes, the configuration rows, the Tailscale serve target with its fallback, which is the current contract, and the socket variant that a passing spike adopts, the handling of Tailscale identity headers, Funnel's separate listener, and own-domain reach with its CAA record and challenge rule. The types package [`@delorun/contract-reach-providers`](../../packages/contract-reach-providers/README.md) carries the option ids, states, rows, codes and the named certificate authority.

<a id="status"></a>
## Status

The Tailscale private provider is built; the Funnel and own-domain providers are not.

- **Built and reached:** setup records reach as off: `--yes` leaves it off, and a `--config` document that names a reach option other than `none` is refused. `@delorun/reach` provides the `reach` service and the Tailscale private provider: `delorun reach on tailscale` or the yes answer in setup's Full mode turns the option on, and the home then binds the fixed listener port, opens the reach listener, and configures `tailscale serve` to the port. The provider refuses Funnel, removes serve rules on its port that it does not own, and rechecks Tailscale every minute by default; `delorun reach off` removes the rule.
- **Not built:** the Funnel and own-domain providers, the visibility notes of the other options, the Funnel target, the socket variant, the own-domain checks of the CAA record and the ACME challenge rule, and the `reach-binding` and `own-domain-caa` checks, which `delorun verify` reports as not run. No real tailnet or phone has exercised the Tailscale private provider; the [reach design](../design/reach.md#never-run-on-a-real-tailnet-or-phone) lists what stays untried. The rules for reach on the person's own tailnet are in the [reach design](../design/reach.md).

The requirements and denial tests below that this list names as not built or reached by nothing protect no one until a change builds and wires them.

<a id="contents"></a>
## Contents

- [Summary](#summary)
- [Status](#status)
- [Contract](#contract)
  - [Reach options](#reach-options)
  - [Provider Service Definition](#provider-service-definition)
  - [States](#states)
  - [Visibility notes](#visibility-notes)
  - [Configuration rows](#configuration-rows)
  - [Tailscale serve target](#tailscale-serve-target)
  - [Identity headers](#identity-headers)
  - [Funnel](#funnel)
  - [Own-domain reach](#own-domain-reach)
  - [Errors](#errors)
  - [Delorun relay client](#delorun-relay-client)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)
  - [What this does not prove](#what-this-does-not-prove)
- [Decided values](#decided-values)

<a id="contract"></a>
## Contract

<a id="reach-options"></a>
### Reach options

| Option id | Listener | TLS ends at | Identity factor | Address |
| --- | --- | --- | --- | --- |
| `tailscale-private` | `reach-tailscale-private` | `tailscaled` on the home | `tailnet-membership` ([C14](c14-oidc-passkeys.md#tailnet-membership)) under the fallback; tailnet identity only under the [socket variant](#tailscale-serve-target) | `https://<machine>.<tailnet>.ts.net`, with the serve port when it is not 443 |
| `tailscale-funnel` | `reach-tailscale-funnel` | `tailscaled` on the home | A passkey or OpenID Connect sign-in | `https://<machine>.<tailnet>.ts.net`, with the Funnel port when it is not 443 |
| `self-hosted-relay` | `reach-self-hosted-relay` | The home's reach listener, with its own certificate | A passkey or OpenID Connect sign-in | `https://<name>` on the person's own domain |

The option ids are those of setup's answers ([C11](c11-setup-answers.md)). Device approval ([C5](c05-device-approval.md)) applies to every option. Which identity factor an address can use is defined in [C14](c14-oidc-passkeys.md#relying-party-ids).

<a id="provider-service-definition"></a>
### Provider Service Definition

The capability seam has three roles. The Service Definition is the Cordis service `reach`, declared by `@delorun/reach`, with a registry of providers. Its Service Providers are the three providers above, each registered by `@delorun/reach`. Its consumers are the reach screens in `@delorun/plugin-reach-ui`, `@delorun/home-auth`, which rotates sessions on a reach-provider change, `@delorun/certificates`, and the verification checks of [C15](c15-verification-checks.md).

- **`reach.register(provider)`** registers a provider for one option id and returns the disposer. A second provider for the same id fails at load.
- **`provider.factor`** declares the identity factor a session created through the option records. `@delorun/home-auth` reads it from this declaration and refuses `tailnet-membership` for any option other than `tailscale-private`.
- **`provider.resolve(rows)`** turns the option's configuration rows into a `ReachSpec`: the address, the listener, the ports and every value the provider would otherwise default. It runs at load, so a missing or invalid row fails there with its error code.
- **`provider.start(spec)`** connects the option's fixed listener port, which the service binds before it calls `start` and relays to the started reach listener, to the outside, and resolves when the provider reaches `ready` or a refusal state.
- **`provider.stop(spec)`** disconnects, confirms that the outside no longer reaches the fixed listener port, and fails with its error code when it cannot. The service stops the provider before it releases the port, adds a failure to the sentence of a start that did not reach `ready`, and logs one at disposal.
- **`provider.check(spec)`** rechecks a ready option every `checkIntervalMs`: `ok`; `unknown`, which makes the option `degraded` until a later check answers; or `blocked`, which stops the option as a failed start does and leaves it `blocked` with the check's code.
- **`provider.visibility(spec)`** returns the option's [visibility note](#visibility-notes) for that spec.
- **`reach/state`** is the event each state change emits, with the option id, the state and its cause.
- **`GET /delorun/reach/status`** answers `{ "available": true, "options": [{ "option", "state", "address"?, "cause"?, "detail"? }] }` to the studio on the loopback listener and to an admitted reach session, and `421 HOST_MISMATCH` to any other arrival. The studio's settings and onboarding read it; a profile without the reach service answers `404`, which a reader takes as no remote access in this profile.
- **The C16 switch `reach`** (`Config.enabled`) mounts the service. Off, the parity value, it registers no provider, opens no listener and answers no route.

`start` runs only when every precondition holds: the home has an owner ([C5](c05-device-approval.md#owner-claim)), or gains one by C5's local claim when the person opens the first approval window; an identity factor that [C14](c14-oidc-passkeys.md) allows for the address is enrolled, is enrolled as part of turning the option on, or is `tailnet-membership`, which needs no enrolment; the person turned the option on interactively, never through `--yes` or `--config` ([C11](c11-setup-answers.md)); and the option's own checks below pass.

<a id="states"></a>
### States

| State | Meaning |
| --- | --- |
| `off` | The listener is stopped and nothing reaches the home through this option. |
| `starting` | The listener is started and the provider is connecting it. |
| `ready` | The address reaches the listener. |
| `degraded` | The provider lost its connection and is reconnecting; the listener refuses nothing it would otherwise admit. |
| `blocked` | A precondition or check failed, such as a missing CAA record or an unexplained certificate. The provider is disconnected and the state names the cause. |
| `stopping` | The provider is disconnecting. |
| `failed` | The provider stopped on an error it cannot retry; the state names the error. |

`starting` leads to `ready`, `blocked` or `failed`; `ready` to `degraded`, `blocked` or `stopping`; `degraded` to `ready`, `blocked` or `stopping`; `blocked` to `starting` when its cause clears, or to `stopping`; `failed` to `starting` when the person retries; `stopping` to `off`. Every change between `off` and any other state is a reach-provider change that rotates every session ([C4](c04-admission.md#rotation-and-revocation)).

<a id="visibility-notes"></a>
### Visibility notes

Each provider publishes a note that setup and the reach screens show before the option turns on and beside it while it is on. The note lists what each party other than the person can see and do. The studio shows the text below, with the placeholders filled, in the interface language.

**Tailscale private.**

> This option uses no Delorun infrastructure. Only devices on your tailnet can open this address. Tailscale's coordination service sees this home's name, the IP addresses of this home and of each device, connection times and traffic volume. Tailscale can add a device to your tailnet unless Tailnet Lock is on. Tailscale controls `ts.net` and obtains the certificate for this address, so no app can pin this address's TLS key. Every device still needs approval, and signing in needs your passkey or sign-in provider.

**Tailscale Funnel.**

> This option uses no Delorun infrastructure. Anyone on the internet can open this address; your passkey or sign-in provider and device approval protect it. Tailscale's Funnel servers and coordination service see this home's name, the IP addresses of this home and of each connecting device, connection times and traffic volume, and pass encrypted traffic to this home, where Tailscale's software ends TLS. Tailscale can add a device to your tailnet unless Tailnet Lock is on. Tailscale controls `ts.net` and obtains the certificate for this address, so no app can pin this address's TLS key.

**Self-hosted relay.**

> This option uses no Delorun infrastructure. Your relay at `<tunnel host>` sees this address's name, the IP addresses of this home and of each connecting device, connection times and traffic volume, and passes encrypted traffic it cannot read; TLS ends on this home. Traffic is end-to-end encrypted while your domain's CAA record lets only this home's Let's Encrypt account obtain certificates (`accounturi`) and this home answers its own certificate challenges. Let's Encrypt and your DNS provider can still affect certificates for your domain; this home checks public certificate logs through `<certificate source>`, which sees this home's IP address and domain, and detection waits until a log includes a certificate.

<a id="configuration-rows"></a>
### Configuration rows

The rows are fields of the `@delorun/reach` plugin's `Config` in the home's profile. They are reach rows: an export file never carries them ([C8](c08-archive-and-trash.md)), and setup writes them only in its interactive form.

| Row | Type | Default | Validation |
| --- | --- | --- | --- |
| `tailscalePrivate.enabled` | boolean | `false` | — |
| `tailscalePrivate.address` | studio address | none | Must equal `https://` and this machine's `ts.net` name as `tailscale status --json` reports it, with the port when it is not 443. |
| `tailscalePrivate.servePort` | integer | `443` | 1 to 65535. |
| `tailscalePrivate.listenerPort` | integer | `0`, none chosen | 1 to 65535 when the option is on; `delorun reach on tailscale` and setup choose it once, at random from 20000 to 32767, and keep it unless another program holds it while Delorun is stopped. An enabled row with `0` fails at load with `PORT_CONFLICT`. |
| `tailscalePrivate.serveCheckIntervalMs` | integer | `60000` | At least `1000`. |
| `tailscalePrivate.elevationMinutes` | integer | `15` | 1 to 60: how long an elevation the person approves for a device on this option lasts ([C14](c14-oidc-passkeys.md#elevation)). An enabled row outside the range fails at load, and at `reach.apply`, with `ELEVATION_MINUTES_INVALID`. |
| `tailscaleFunnel.enabled` | boolean | `false` | — |
| `tailscaleFunnel.address` | studio address | none | As `tailscalePrivate.address`, with the Funnel port. |
| `tailscaleFunnel.funnelPort` | integer | `8443` | `443`, `8443` or `10000`, the ports Funnel accepts, and different from `servePort` when both options are on. |
| `selfHostedRelay.enabled` | boolean | `false` | — |
| `selfHostedRelay.address` | studio address | none | `https://<name>` with a DNS name the person's domain holds, and no port. |
| `selfHostedRelay.tunnelUrl` | URL | none | `wss://<tunnel host>/v1/tunnel` of the person's relay ([C6](c06-relay-protocol.md#relay-configuration)). |
| `certificates.ctSource` | URL | the [C6 default](c06-relay-protocol.md#certificate-monitoring) | An `https` URL. |

No row sets a listener's address ([C4](c04-admission.md#listeners)). Secrets of the options live under `~/.delorun/secrets/reach/` and `~/.delorun/secrets/certificates/` ([C1](c01-home-layout.md#secrets)), never in a row.

<a id="tailscale-serve-target"></a>
### Tailscale serve target

**Current contract: the fallback.** The Tailscale private target is the fixed TCP port `tailscalePrivate.listenerPort` on `127.0.0.1`. The service binds it before the provider writes the serve rule and relays each connection on it to `reach-tailscale-private`, whose port the operating system assigns; a port that does not bind leaves the option `blocked` with `PORT_CONFLICT`, after the service removes any rule on the serve port, and no rule is written. The provider configures the target with `tailscale serve --bg --https=<servePort> http://127.0.0.1:<listenerPort>`, which `tailscaled` keeps until it is removed, and removes it with `tailscale serve --https=<servePort> off`. Under the fallback:

- identity headers are trusted on no listener, including this one;
- tailnet-private reach signs a device in with `tailnet-membership` ([C14](c14-oidc-passkeys.md#tailnet-membership)): an approved device's key alone, after an approval at the home's own computer ([C5](c05-device-approval.md#local-approval)); the header-based `tailnet` identity factor is refused with `TAILNET_IDENTITY_UNAVAILABLE`;
- owner claim is accepted only on the loopback listener ([C5](c05-device-approval.md#owner-claim));
- a local process that connects to the target port is admitted only as any remote device would be.

Before `start` configures the target, the provider checks that `tailscale` is installed (`TAILSCALE_NOT_INSTALLED`), runs and is signed in (`TAILSCALE_NOT_LOGGED_IN`), that the tailnet has HTTPS certificates on for this machine (`TAILSCALE_HTTPS_DISABLED`) and that the configured address is this machine's `ts.net` name (`TAILSCALE_ADDRESS_MISMATCH`). It runs every `tailscale` command itself, with an argument list and never through `sudo`; when the person's user may not configure `tailscale serve`, it refuses with `TAILSCALE_SERVE_NOT_PERMITTED` and prints the one command the person runs themselves, `sudo tailscale set --operator=$USER`. It then reads `tailscale serve status --json`, the JSON of Tailscale's `ipn.ServeConfig` (`TCP` by port, `Web` and `AllowFunnel` by `<ts.net name>:<port>`, and the same fields for each foreground session under `Foreground`), for the serve address `<ts.net name>:<servePort>`. While `AllowFunnel` allows that address in any configuration, the option does not start and is `blocked` with `TAILSCALE_FUNNEL_ON`, naming `tailscale funnel --https=<servePort> off`; `delorun reach on tailscale` and setup refuse the same way. Any other rule on the serve port that is not this home's own, HTTPS in the background configuration with the one mount point `/` proxying to `http://127.0.0.1:<listenerPort>`, is removed with the `off` command of its kind (`--https`, `--http` or `--tcp`), and the status is read again; a removal that fails or leaves the port served is `TAILSCALE_SERVE_CONFLICT`, and no rule is written. `delorun reach on tailscale` removes such rules too, and the home's own rule as well while Delorun is stopped, since no program of the home then holds its port. The provider's stop and `delorun reach off` remove whatever is served on the serve port and read the status again to confirm it is gone; `delorun reach off` exits non-zero with the reason when it is not. While the option is ready the service rereads the status every `serveCheckIntervalMs`: Funnel found on the serve address removes the rule, closes the listeners and leaves the option `blocked` with `TAILSCALE_FUNNEL_ON`, and a status it cannot read makes the option `degraded` until a later read answers.

**Socket variant, adopted only by a passing spike.** Where the spike result recorded under [compatibility](#compatibility) passes for a platform, the target on that platform is the Unix socket `~/.delorun/run/<profile>/serve.sock` ([C1](c01-home-layout.md)), created by the home process and set to mode 0600 after it binds. The provider configures it with the command the spike recorded. On each accepted connection the home reads the peer's credentials (`SO_PEERCRED` on Linux, `getpeereid` on macOS) and closes the connection unless the peer's user is the user `tailscaled` runs as and that user is not the person's user. Under the variant, identity headers are trusted on this socket only, a claim on it may set the tailnet login allowlist, and the `tailnet` identity factor is available for `tailscale-private`. When the peer-credential condition does not hold at start, for example because `tailscaled` runs as the person's user, the provider uses the fallback on that home and says so in its state.

**Spike evidence.** A spike result adopts the variant for one platform only when its committed report records all of these:

1. The operating system and its version, and the Tailscale client version, from `tailscale version`.
2. The exact commands that configured the serve target and removed it.
3. The socket's mode and owner, from `stat`, and the user `tailscaled` runs as, from `ps`.
4. That a browser on another tailnet device received a response from the home through the socket target.
5. The reachability test: an HTTP request to the socket from a process of the person's user outside any sandbox, from a confined command under each sandbox dialect that platform has ([C1](c01-home-layout.md)), from a process of another local user, and from a container on the default Docker network, each with its result. The variant passes only when none of them receives a response and the home logged each as refused by the peer-credential check.
6. That forged `Tailscale-User-Login` headers sent by each of those processes reached no handler.

When the socket target does not work, or any process in step 5 receives a response, the fallback stays the contract on that platform.

<a id="identity-headers"></a>
### Identity headers

Tailscale identity headers are request headers whose names begin with `Tailscale-` in any case, such as `Tailscale-User-Login`, `Tailscale-User-Name` and `Tailscale-User-Profile-Pic`. Every reach listener removes them before admission ([C4](c04-admission.md#dispatch-order)), and the loopback listener ignores them. The only exception is the socket variant's socket, on a connection that passed the peer-credential check. There, `Tailscale-User-Login` names the tailnet login; a login on the tailnet login allowlist may sign in with the `tailnet` identity factor, and the owner's claim on that socket sets the allowlist's first entry.

<a id="funnel"></a>
### Funnel

Funnel always targets its own listener, `reach-tailscale-funnel`, on its own TCP port on `127.0.0.1`, never the private target. The provider configures it with `tailscale funnel --bg --https=<funnelPort> http://127.0.0.1:<bound port>` and removes it with `tailscale funnel --https=<funnelPort> off`. The Funnel listener trusts no identity header under any variant. The provider refuses to start with `FUNNEL_NOT_PERMITTED` when the tailnet policy does not grant this machine the `funnel` attribute, and with `PORT_CONFLICT` when `funnelPort` equals an enabled `servePort`.

<a id="own-domain-reach"></a>
### Own-domain reach

Own-domain reach is the self-hosted relay option. The certificate authority this contract names is Let's Encrypt.

- **Named CA.** The CAA issuer domain is `letsencrypt.org`, and the home's ACME client uses only the directory `https://acme-v02.api.letsencrypt.org/directory`. The home's ACME account key is an ECDSA P-256 key in `~/.delorun/secrets/certificates/acme-account.pem`, and its account URL is recorded in `~/.delorun/secrets/certificates/account.json`.
- **Required CAA record.** The relevant CAA record set of the address's name, found as RFC 8659 describes by climbing from the name towards the root, holds `0 issue "letsencrypt.org; accounturi=<the home's account URL>; validationmethods=tls-alpn-01"`. Every `issue` and `issuewild` property in that set names `letsencrypt.org` with that `accounturi`; a set that also names another issuer, or another account, fails. Setup shows the exact record to add.
- **Parameters checked.** Let's Encrypt's CAA documentation names the RFC 8657 parameters `accounturi` and `validationmethods`, so the check `own-domain-caa` ([C15](c15-verification-checks.md)) asserts both and no other parameter. The end-to-end wording rests only on `accounturi` and on the challenge rule below.
- **When it is checked.** The provider checks the record before it starts, before each ACME order and every 24 hours. A missing or mismatched record puts the provider in `blocked` with `CAA_MISSING` or `CAA_MISMATCH` in every verification mode, so reach on that domain stays off.
- **Challenge rule.** While the relay is in the path, the home uses only TLS-ALPN-01, answered by its own reach listener through its key-proven tunnel ([C6](c06-relay-protocol.md#sni-routing)). It never starts an HTTP-01 or a DNS-01 challenge. A `_acme-challenge` record for the name that is a CNAME into a zone Delorun controls (`delo.run`, `delorun.com`) puts the provider in `blocked` with `CHALLENGE_DELEGATED`. Delorun delegates no challenge.
- **TLS key.** The home keeps one TLS key per name in `~/.delorun/secrets/certificates/<name>/key.pem` across renewals, and renews 30 days before a certificate expires.

<a id="errors"></a>
### Errors

| Code | Raised when |
| --- | --- |
| `TAILSCALE_NOT_INSTALLED` | `tailscale` is not on the home's path. |
| `TAILSCALE_NOT_LOGGED_IN` | The Tailscale client is not logged in to a tailnet. |
| `TAILSCALE_ADDRESS_MISMATCH` | The configured address differs from the name Tailscale reports. |
| `TAILSCALE_HTTPS_DISABLED` | The tailnet does not have HTTPS certificates on for this machine. |
| `TAILSCALE_SERVE_NOT_PERMITTED` | The person's user may not configure `tailscale serve`. |
| `TAILSCALE_SERVE_CONFLICT` | A serve rule on the serve port could not be removed, or the port is still served after the removal. |
| `TAILSCALE_FUNNEL_ON` | Tailscale Funnel is allowed for the Tailscale private address. |
| `FUNNEL_NOT_PERMITTED` | The tailnet policy does not grant the `funnel` attribute. |
| `PORT_CONFLICT` | `funnelPort` equals an enabled `servePort`, a port row is out of range or unchosen, or another program holds `tailscalePrivate.listenerPort`. |
| `ELEVATION_MINUTES_INVALID` | `tailscalePrivate.elevationMinutes` is not a whole number from 1 to 60. |
| `NO_OWNER` | The home has no owner. |
| `NO_IDENTITY_FACTOR` | No identity factor that C14 allows for the address is enrolled. |
| `TAILNET_IDENTITY_UNAVAILABLE` | The `tailnet` identity factor under the fallback. |
| `CAA_MISSING` | No relevant CAA record set, or none naming `letsencrypt.org`. |
| `CAA_MISMATCH` | The set names another issuer or account, or lacks a required parameter. |
| `CHALLENGE_DELEGATED` | `_acme-challenge` is a CNAME into a zone Delorun controls. |
| `RELAY_UNREACHABLE` | The relay's tunnel host does not answer. |
| `RELAY_REFUSED` | The relay refused the token or the handshake ([C6](c06-relay-protocol.md#errors)). |
| `CERTIFICATE_UNEXPLAINED` | An unrequested certificate is unexplained ([C6](c06-relay-protocol.md#certificate-monitoring)). |

<a id="delorun-relay-client"></a>
### Delorun relay client

Delorun does not include a Delorun relay client ([roadmap](../guide/roadmap.md)): it registers no `delorun-relay` provider, and setup does not offer the option. Such a provider registers through the same Service Definition with the option id `delorun-relay`, publishes a visibility note that names what the hosted service can see and do, including that Delorun could obtain a publicly logged certificate for a `delo.run` name, and follows [C6's rules for the Delorun relay](c06-relay-protocol.md#delorun-relay).

<a id="consumers"></a>
## Consumers

- `delorun/packages/reach/`: the Service Definition, the three providers, the serve and Funnel configuration and the relay client.
- `delorun/packages/certificates/`: the ACME client, the CAA check and the challenge rule.
- `delorun/packages/plugin-reach-ui/`: the reach screens and the visibility notes.
- `delorun/packages/home-auth/`: rotation on a reach-provider change and the `tailnet` identity factor.
- `delorun/packages/contract-reach-providers/`: option ids, states, rows, codes and the named CA.
- [C11](c11-setup-answers.md) for the option ids, [C15](c15-verification-checks.md) for `reach-binding` and `own-domain-caa`, [C8](c08-archive-and-trash.md) for reach rows in export files.

<a id="compatibility"></a>
## Compatibility

The option ids, state names, row names and error codes are fixed. A new option is a new id with its own provider and visibility note; a change to a note's wording is a change to this contract, because people rely on it.

The spike result on the Tailscale serve target is not recorded on this page, so the fallback is the contract on every platform. A passing spike result adopts the socket variant only for the platforms and Tailscale client versions its report names, by a change to this section that records the report's evidence. A Tailscale client older than the recorded version keeps the fallback, and the peer-credential condition is checked at every start.

Every reach option is off in the parity composition ([C16](c16-parity-composition.md)), and turning reach on adds no model-visible input.

<a id="security"></a>
## Security

Requirements:

- Each provider publishes its visibility note, which names the IP addresses of the home and each device, connection times and traffic volume; for Tailscale it says that Tailscale can add a device unless Tailnet Lock is on and that Tailscale obtains the `ts.net` certificate.
- Under the fallback, which is the current contract, identity headers are trusted on no listener and tailnet-private reach signs in with `tailnet-membership`, so a device is approved only at the home's own computer and its session is refused every action C14 reserves for that computer; the fallback also applies whenever a local process other than `tailscaled` can reach the serve target.
- Under the socket variant, identity headers are trusted only on the mode-0600 serve socket from a peer whose user is `tailscaled`'s, and dropped everywhere else; the tailnet login allowlist is set at owner claim.
- Funnel targets its own listener, which trusts no identity header.
- While the home runs, the Tailscale private serve rule names a port the home holds: the fixed listener port binds before the rule is written, a rule on the serve port that is not the home's own is removed and confirmed gone first, and the stop removes the rule and confirms it before the port is released. Tailscale private never serves while Funnel is allowed for its address.
- Own-domain reach requires the CAA record whose `accounturi` names the home's Let's Encrypt account, and `delorun verify` asserts only the parameters Let's Encrypt documents.
- While a relay is in the path, the home starts no challenge that a party other than the home answers, and no challenge is delegated to Delorun.
- A reach option turns on only interactively, after its visibility note, with an owner and an allowed identity factor.

Denial tests:

| Test name | Behaviour proven |
| --- | --- |
| `forged identity headers on a loopback port are ignored` | A request to each reach listener's port and to the loopback listener with forged `Tailscale-User-Login` headers reaches admission without them, and under the fallback the same holds on the serve target. |
| `forged identity headers on the Funnel listener are ignored` | Forged `Tailscale-*` headers on `reach-tailscale-funnel` never sign anyone in, under either variant. |
| `the tailnet factor is refused under the fallback` | Enrolling or signing in with the `tailnet` identity factor fails with `TAILNET_IDENTITY_UNAVAILABLE`. |
| `a same-user process gets no response from the serve socket` | Under the socket variant, a connection from a process of the person's user is closed by the peer-credential check before any request is read. |
| `an own domain without the CAA record fails verify and stays off` | With no CAA record, or one naming another account or issuer, `delorun verify` fails `own-domain-caa`, and the self-hosted relay provider stays `blocked` in every verification mode. |
| `with a relay in the path the home starts no off-home challenge` | Against the ACME stand-in, every challenge the home starts while the relay is in the path is TLS-ALPN-01 answered by the home's reach listener, and it starts no HTTP-01 or DNS-01 challenge. |
| `a challenge delegated to Delorun blocks the provider` | A `_acme-challenge` CNAME into `delo.run` puts the provider in `blocked` with `CHALLENGE_DELEGATED`. |
| `Funnel and serve cannot share a port` | Enabling both options with the same port fails with `PORT_CONFLICT`. |
| `refuses a fixed port another program holds, removing the rule an earlier run left there` | With `listenerPort` held by another program, the option is `blocked` with `PORT_CONFLICT`, no rule is written and a rule left on the serve port is removed. |
| `removes a rule this home does not own and confirms it is gone before writing its own` | A rule on the serve port to another target is removed and the status read again before the home's rule is written; a removal that fails leaves the option `blocked` with `TAILSCALE_SERVE_CONFLICT` and writes nothing. |
| `refuses to start while Funnel is on for the address, and removes the rule` | With Funnel allowed for the address, the option is `blocked` with `TAILSCALE_FUNNEL_ON` and no rule is written. |
| `stops serving when Funnel is turned on while ready, and marks an unreadable status degraded` | Funnel allowed after start is found at the next check, which removes the rule, closes the listeners and leaves the option `blocked` with `TAILSCALE_FUNNEL_ON`. |

<a id="what-this-does-not-prove"></a>
### What this does not prove

- **The CAA `validationmethods` check.** `own-domain-caa` asserts `validationmethods=tls-alpn-01` because Let's Encrypt supports the RFC 8657 parameters, which the certificates tests of the reach work package confirm against Let's Encrypt's documented behaviour. The check reads the record through the home's resolver; the certificate authority's own lookup is the control that applies at issuance.
- **Windows.** Windows has no peer-credential check for a Unix socket, so it has no socket variant: the fallback is the contract there whatever a spike records on other platforms.
- **Tailscale.** Tailscale's coordination service can add a device to the tailnet unless Tailnet Lock is on, and Tailscale obtains the `ts.net` certificate; no Delorun check detects either.
- **A local process under the fallback.** Under the fallback any local process can connect to the Tailscale private target; it is then admitted only as a remote device would be, so this contract does not keep it from trying to sign in.
- **A home process that dies without stopping.** `tailscaled` keeps the rule, which then names a fixed listener port no program of the home holds until the next start, `delorun reach on tailscale` or `delorun reach off`. A program of another local user that binds the port in that time is served on the phone's `ts.net` origin. The next start finds the port held, removes the rule and stays `blocked`, but nothing removes the rule earlier.
- **Tailscale's serve status.** The specs read `tailscale serve status --json` as Tailscale's `ipn.ServeConfig` source defines it; no real tailnet has exercised the reading, the removal commands or Funnel detection.

<a id="decided-values"></a>
## Decided values

- The named certificate authority: Let's Encrypt, CAA issuer domain `letsencrypt.org`, ACME directory `https://acme-v02.api.letsencrypt.org/directory`, with `accounturi` and `validationmethods=tls-alpn-01` asserted.
- The CAA record is checked before start, before each ACME order and every 24 hours; certificates renew 30 days before expiry.
- The Tailscale private target: a TCP port on `127.0.0.1` (the fallback) on every platform, until a spike result adopts the socket variant for a platform.
- The default ports: 443 for Tailscale private and 8443 for Funnel.
- The fixed listener port is chosen from 20000 to 32767, below the ephemeral port ranges of Linux, macOS and Windows; the serve status is reread every 60 seconds by default, and an interval below one second is refused.
