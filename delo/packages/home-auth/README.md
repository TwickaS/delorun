---
description: "Delo's sign-in for reach, for maintainers of the admission seam: the owner claim and device list over a home's protected records, the authenticator provider that C4, C5 and C14 describe, and the denial suite that proves C4's listener and dispatch rules over Delo's shipped web composition."
---

# @delo/home-auth

English | [中文](README.zh.md)

## Summary

This package is the home of the authenticator provider of [contract C4](../../docs/contracts/c04-admission.md#authenticator), with the owner claim and device approval of [C5](../../docs/contracts/c05-device-approval.md), the identity factors of [C14](../../docs/contracts/c14-oidc-passkeys.md) and the server-side reach sessions of C4. What it holds today provides no `authenticator`, no sign-in, no device approval and no identity factor, and no shipped profile or command mounts it, so none of its routes answers in a running Delo; the studio is admitted by upstream's launch token and cookies alone. The first half is the owner claim and device list: the records under `~/.delo/secrets/home-auth/`, the routes that answer them, and the removal that ends a device's live sessions. The second half is C4's admission denial suite, which proves the upstream half of the seam: upstream's connection declares the `Authenticator` Service Definition and opens reach listeners with `ctx.connection.openReachListener`, and the web server runs each reach listener's dispatcher before any route, upgrade or the fallback. The contract's identifiers, codes and limits come from [`@delo/contract-admission`](../contract-admission/README.md).

## Contents

- [The owner claim and device list](#the-owner-claim-and-device-list)
- [The admission denial suite](#the-admission-denial-suite)
- [Notes for the provider](#notes-for-the-provider)
- [Tests](#tests)

## The owner claim and device list

`src/home-auth.ts` is the coordinator over `~/.delo/secrets/home-auth/`, and `src/service.ts` mounts it as the `homeAuth` service, which registers `POST /auth/owner/claim`, `GET /auth/devices` and `POST /auth/devices/remove` with the web server inside `ctx.effect()`. Each rule below is what one spec under `tests/` pins:

- **The owner code** (`owner-code.json`). 128 bits written as 26 base32 characters, printed once and kept only as a SHA-256 digest. A code is single-use and expires 10 minutes after it was printed; a wrong code leaves the outstanding one in place, and a new code replaces it.
- **The claim** (`owner.json`, `devices.json`). Loopback only, and a `Host` naming a reach address is refused even when nothing stamped the request. The claim records the listener's own origin, `http://127.0.0.1:3080`, whatever spelling of loopback the request used — `localhost`, `127.0.0.1`, `[::1]`, a `.localhost` name, with or without a port, through SSH port forwarding — and refuses a `Host` that is no authority at all with `BAD_REQUEST`, so a header an attacker wrote never becomes a device's address. One home has one owner: a second claimant with a fresh valid code is refused with `ALREADY_OWNED` and the first owner keeps the home, and two claims that race are serialised, so exactly one wins the owner seat. The code is consumed before a record is written, so a code that claimed a home never claims a second one, and a home that records devices but no owner refuses a claim with `STORE_INVALID` rather than taking ownership of them.
- **The arrival of the device routes**. `GET /auth/devices` and `POST /auth/devices/remove` answer on the loopback listener only: both decide the arrival before they read anything, refuse a `Host` that names another address with `421 HOST_MISMATCH`, and the removal additionally refuses a page on another origin — an `Origin` other than the request's own, or a foreign `Sec-Fetch-Site` — with `403 ORIGIN_MISMATCH`. That is what keeps a page served from a name that resolves to `127.0.0.1` (DNS rebinding) from reading the home's records or removing a device, and a cross-site form from posting the removal.
- **The device list**. The owner and every trusted device, without key material. An unclaimed home refuses the listing and the removal with `NO_OWNER`, rather than answering as if it had an empty device list. The owner record and the device list are cross-checked, so a copied `owner.json` naming a first device this home does not record is a `STORE_INVALID` failure rather than an owner, and no listing, session or removal acts for it.
- **The sessions** (`sessions.json`). A token is handed out once and kept as the SHA-256 digest that keys its record, so a copy of the file signs nobody in. A session is minted only for a recorded device at the address it is trusted on: a home with no owner refuses with `NO_OWNER`, an owner record that cannot be read with `STORE_INVALID`, and a key this home does not record — a device of another home, one at another address, or one just revoked — with `DEVICE_NOT_TRUSTED`. A session reads as live only while its device is still recorded at the session's address, so a token whose device is gone answers nothing even when its own record survived.
- **The removal**. Deletes the device's record, invalidates every live session of its tokens, and closes the reach connections those sessions admitted through `ctx.connection.closeReachConnections({ deviceId })`, all before it returns; a device with no record still has its sessions ended. **Rotation is not implemented yet.** C5's "Removal" also rotates every other session of the home, and this home has no token-rotation route that could redeem a rotated token, so a removal ends exactly the removed device's sessions and leaves every other device's sessions live. Rotation belongs to the sign-in routes; until then, ending another device's session would sign out devices the person did not touch, which no route of this package asks for (the `leaves another device's sessions live` spec holds this deviation).
- **The limits**. A home trusts at most 32 devices (`DEVICE_LIMIT_REACHED`, `429`) and one device holds at most 16 live sessions (`SESSION_LIMIT_REACHED`, `429`); a session record whose lifetime passed is dropped before the bound is counted, so a device that signs in again after its sessions expired is never refused by them.
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
- **The device routes' arrival.** The listing and the removal decide the arrival before they read anything, and both refuse a request whose `Host` names another address; the removal also refuses a page on another origin. Neither route reads a home-auth session cookie yet: this package has no route that mints one for the studio, and the devices screen that C5's "a trusted device in a live session" names belongs to the reach UI, so the loopback arrival — plus the removal's origin fence — is the guarantee these routes give until that screen lands. A reach listener's authenticated request therefore reaches neither route today.
- **Revocation.** Removing a device or ending a session calls `ctx.connection.closeReachConnections({ deviceId })` or `({ sessionId })` before it returns, so streams and upgraded sockets that carry no Peer, such as `/plugins/events` and plugin upgrade routes, end with the session; disposing the device's Peer ends the streams that speak for it.
- **Loopback credentials.** Each loopback mint arrives as `authenticator/minted`, and a provider records it before the response that sets it is written.

## Tests

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/home-auth` runs the suite. It imports upstream packages through their published entry points, so it needs a current `pnpm run build:artifacts`, which Delo's check runner starts when the build is stale.
