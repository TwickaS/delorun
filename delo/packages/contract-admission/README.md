---
description: "Types-only package holding the listener ids, admission results, pre-login routes, refusal codes, session cookie and session limits of a home's admission, as specified by contract C4."
---

# @delo/contract-admission

English | [中文](README.zh.md)

## Summary

This types-only package exports the identifiers and limits of a home's admission: the listener ids and their policies, the result of the Authenticator's `admit`, the pre-login routes of a reach listener, the refusal codes with their HTTP statuses, the reach session cookie and the session lifetimes. Upstream's connection and web server edits, `@delo/home-auth` and `@delo/reach` import these definitions, so each code and limit has one definition. The specification is [contract C4](../../docs/contracts/c04-admission.md).

## Exports

- `LISTENER_IDS`, `ListenerId`, `ReachListenerId`, `DeclaredScheme`, `HostRule` and `ListenerPolicy`: the listeners and the policy the dispatcher reads.
- `DeviceId`, `SessionId` and `StudioAddress`: the branded ids of a trusted device, a session record and a studio address.
- `Admission`: the three results of `admit`.
- `HOME_AUTH_PRE_LOGIN_ROUTES` and `PreLoginRoute`: the routes a reach listener serves before sign-in.
- `ADMISSION_REFUSAL_CODES`, `ADMISSION_REFUSAL_STATUS` and `REACH_LISTENER_HOST_OVERRIDE`: the refusals and the load failure.
- `ROTATION_TRIGGERS`: the events that rotate every session.
- `REACH_SESSION_COOKIE`, `UPSTREAM_COOKIE_PREFIX`, `SESSION_TOKEN_BYTES`, `SESSION_LIMITS`, `LOOPBACK_COOKIE_MAX_AGE_DAYS`, `SESSION_STORE_PERSIST_MS` and `SESSION_STORE_VERSION`: the cookie, the token size, the lifetimes and the store.
- `LOOPBACK_LISTENER_ADDRESS` and `REACH_LISTENER_BIND_HOST`: the listener addresses.
- `CSP_NONCE_BYTES`, `TRUSTED_TYPES_POLICIES` and `PLUGIN_SCRIPT_PATH_PREFIX`: the Content Security Policy nonce and the Trusted Types policies.

## Limits

The package has no runtime code. It depends only on the workspace brand package, for the branded ids. `Admission` takes the Peer type as a parameter, so the package imports nothing from upstream. A change to a code, a limit or a route follows the compatibility section of the contract.
