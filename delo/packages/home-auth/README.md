---
description: "Delo's sign-in for reach, for maintainers of the admission seam: the authenticator provider that C4, C5 and C14 describe, and the denial suite that proves C4's listener and dispatch rules over Delo's shipped web composition."
---

# @delo/home-auth

English | [中文](README.zh.md)

## Summary

This package is where `@delo/home-auth`, the authenticator provider of [contract C4](../../docs/contracts/c04-admission.md#authenticator), lives: the owner claim and device approval of [C5](../../docs/contracts/c05-device-approval.md), the identity factors of [C14](../../docs/contracts/c14-oidc-passkeys.md), and the server-side reach sessions of C4. It holds no provider code yet. It holds C4's admission denial suite, which proves the upstream half of the seam: upstream's connection declares the `Authenticator` Service Definition and opens reach listeners with `ctx.connection.openReachListener`, and the web server runs each reach listener's dispatcher before any route, upgrade or the fallback. The contract's identifiers, codes and limits come from [`@delo/contract-admission`](../contract-admission/README.md).

## Contents

- [The admission denial suite](#the-admission-denial-suite)
- [Tests](#tests)

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
| `a loopback Host is refused on a reach listener` | `localhost`, `127.0.0.1` and `[::1]` in `Host` are refused with `HOST_MISMATCH`. |
| `each listener refuses a Host its rule does not allow` | Each reach listener refuses the other listeners' addresses and a foreign name; the relay listener refuses an SNI other than its name with `SNI_MISMATCH`; the loopback listener refuses a foreign `Host` with upstream's 403. |
| `an upgrade with a foreign or absent Origin is refused` | An upgrade to `/api/remote.mux` without `Origin`, with another origin or with `null` is refused with `ORIGIN_MISMATCH`; the listener's own origin reaches the upgrade handler. |
| `removes Tailscale identity headers before admission` | The provider never sees a `Tailscale-*` header on any reach listener. |
| `no reach listener runs without home-auth` | Removing the provider closes every reach listener and its open connections; no reach listener opens without a provider, the loopback listener admits as upstream does, and a replacement provider that serves no reach listener opens none. |

A type-level check holds C4's `Admission` and `ListenerPolicy` types assignable to the upstream seam's, and a spec holds the dispatcher's refusal statuses equal to C4's.

## Tests

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/home-auth` runs the suite. It imports upstream packages through their published entry points, so it needs a current `pnpm run build:artifacts`, which Delo's check runner starts when the build is stale.
