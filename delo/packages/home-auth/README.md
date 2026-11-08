---
description: "Delo's sign-in for reach, for maintainers of the admission seam: the owner claim and device list over a home's protected records, the authenticator provider that C4, C5 and C14 describe, and the denial suite that proves C4's listener and dispatch rules over Delo's shipped web composition."
---

# @delo/home-auth

English | [中文](README.zh.md)

## Summary

This package is where `@delo/home-auth`, the authenticator provider of [contract C4](../../docs/contracts/c04-admission.md#authenticator), lives: the owner claim and device approval of [C5](../../docs/contracts/c05-device-approval.md), the identity factors of [C14](../../docs/contracts/c14-oidc-passkeys.md), and the server-side reach sessions of C4. The first half is the owner claim and device list: the records under `~/.delo/secrets/home-auth/`, the routes that answer them, and the removal that ends a device's live sessions. The second half is C4's admission denial suite, which proves the upstream half of the seam: upstream's connection declares the `Authenticator` Service Definition and opens reach listeners with `ctx.connection.openReachListener`, and the web server runs each reach listener's dispatcher before any route, upgrade or the fallback. The contract's identifiers, codes and limits come from [`@delo/contract-admission`](../contract-admission/README.md).

## Contents

- [The owner claim and device list](#the-owner-claim-and-device-list)
- [The admission denial suite](#the-admission-denial-suite)
- [Notes for the provider](#notes-for-the-provider)
- [Tests](#tests)

## The owner claim and device list

`src/home-auth.ts` is the coordinator over `~/.delo/secrets/home-auth/`, and `src/service.ts` mounts it as the `homeAuth` service, which registers `POST /auth/owner/claim`, `GET /auth/devices` and `POST /auth/devices/remove` with the web server inside `ctx.effect()`. Each rule below is what one spec under `tests/` pins:

- **The owner code** (`owner-code.json`). 128 bits written as 26 base32 characters, printed once and kept only as a SHA-256 digest. A code is single-use and expires 10 minutes after it was printed; a wrong code leaves the outstanding one in place, and a new code replaces it.
- **The claim** (`owner.json`, `devices.json`). Loopback only, and a `Host` naming a reach address is refused even when nothing stamped the request. One home has one owner: a second claimant with a fresh valid code is refused with `ALREADY_OWNED` and the first owner keeps the home, and two claims that race are serialised, so exactly one wins the owner seat. The code is consumed before a record is written, so a code that claimed a home never claims a second one.
- **The device list**. The owner and every trusted device, without key material. An unclaimed home refuses the listing and the removal with `NO_OWNER`, rather than answering as if it had an empty device list.
- **The sessions** (`sessions.json`). A token is handed out once and kept as the SHA-256 digest that keys its record, so a copy of the file signs nobody in.
- **The removal**. Deletes the device's record, invalidates every live session of its tokens, and closes the reach connections those sessions admitted through `ctx.connection.closeReachConnections({ deviceId })`, all before it returns; a device with no record still has its sessions ended.
- **The records**. Every file is read through [contract C1](../../docs/contracts/c01-home-layout.md)'s protected-file check, so a file another user can read, or one that is not this package's JSON, refuses with `STORE_INVALID` instead of reading as empty and letting a claim replace it.

## The admission denial suite

`tests/denial/admission/` boots the web composition of Delo's CLI profiles in the test process: upstream's web template, which Delo's profiles extend, with the web server on a port the operating system assigns. Delo's own bundle layer is left out because its host half registers no web route. The suite then loads a stand-in provider, `StandInHomeAuth`, which admits one session cookie and delegates the loopback listener to Connection's built-in admission, and a fixture community plugin with an exact route, a prefix route and an upgrade route. It opens all three reach listeners: `reach-tailscale-private` and `reach-tailscale-funnel` on `127.0.0.1` ports, and `reach-self-hosted-relay` on streams a local TCP server hands to it with a certificate from the stand-in stack's test authority.

The tests are named after C4's denial table:

| Test | What it proves |
| --- | --- |
| `every route and upgrade answers 401 before sign-in on each reach listener` | Every exact route, prefix route, upgrade route and the fallback the booted composition registers, and the fixture plugin's, answers 401 on each reach listener, and no fixture handler runs; with a session the same fixture route and upgrade run. |
| `a plugin route is pre-login only when the profile lists it` | A fixture route the provider answers as pre-login is refused until the listener's policy lists it, and refused again when the listing is removed. |
| `a pre-login request never reaches the fallback or another route` | An allowlisted path with no registered route is refused rather than served by the fallback. |
| `a cookie minted with upstream's secret is refused on a reach listener` | A `dsh-auth-*` cookie that upstream minted for the reach listener's own authority, and that admits on the loopback listener, is refused with `UPSTREAM_COOKIE_REFUSED`, also beside a session cookie. |
| `launch tokens and /connect are refused on a reach listener` | The process launch token in a `token` query and requests for `/connect` are refused, and no cookie is set. |
| `a loopback Host is refused on a reach listener` | `localhost`, `127.0.0.1` and `[::1]` in `Host` are refused with `HOST_MISMATCH`, on requests and upgrades. |
| `each listener refuses a Host its rule does not allow` | Each reach listener refuses the other listeners' addresses and a foreign name; the relay listener refuses an SNI other than its name with `SNI_MISMATCH`; the loopback listener refuses a foreign `Host` with upstream's 403. |
| `an upgrade with a foreign or absent Origin is refused` | An upgrade to `/api/remote.mux` without `Origin`, with another origin or with `null` is refused with `ORIGIN_MISMATCH`; the listener's own origin reaches the upgrade handler. |
| `removes Tailscale identity headers before admission` | The provider never sees a `Tailscale-*` header on any reach listener, on a request or an upgrade, and the Gateway's WebSocket still accepts the upgrade. |
| `no reach listener runs without home-auth` | Removing the provider closes every reach listener and its open connections; no reach listener opens without a provider, the loopback listener admits as upstream does, and a replacement provider that serves no reach listener opens none. |

A type-level check holds C4's `Admission` and `ListenerPolicy` types assignable to the upstream seam's, and a spec holds the dispatcher's refusal statuses equal to C4's.

## Notes for the provider

- **Pre-login asset routes.** A handler for `GET /auth/assets/<asset>` resolves the segment against a fixed table of built asset names. It never decodes the segment and then joins it to a directory path, because a decoded `..` or separator would leave the asset directory.
- **The claim's arrival.** The claim route decides where the request arrived before it reads the body, and its refusal names the loopback listener and SSH port forwarding; a reach listener answers the same refusal through `reachClaimRefusal()` before any route is consulted.
- **Revocation.** Removing a device or ending a session calls `ctx.connection.closeReachConnections({ deviceId })` or `({ sessionId })` before it returns, so streams and upgraded sockets that carry no Peer, such as `/plugins/events` and plugin upgrade routes, end with the session; disposing the device's Peer ends the streams that speak for it.
- **Loopback credentials.** Each loopback mint arrives as `authenticator/minted`, and a provider records it before the response that sets it is written.

## Tests

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/home-auth` runs the suite. It imports upstream packages through their published entry points, so it needs a current `pnpm run build:artifacts`, which Delo's check runner starts when the build is stale.
