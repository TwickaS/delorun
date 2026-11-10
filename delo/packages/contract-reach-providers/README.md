---
description: "Types-only package holding the reach option ids and listeners, provider states and transitions, configuration rows, the Tailscale serve target variants and spike evidence, identity header rules, the named certificate authority and error codes of reach providers, as specified by contract C7."
---

# @delo/contract-reach-providers

English | [中文](README.zh.md)

## Summary

This types-only package exports the definitions of reach providers: the reach option ids and the listener each one connects, the provider states and their transitions, the configuration rows, the two Tailscale serve target variants with the evidence a spike report records, the identity header rules, the certificate authority that own-domain reach names with the CAA parameters checked, and the error codes. The stand-ins in `delo/apps/tools` and `@delo/contract-oidc-passkeys` import these definitions, so each option, state and code has one definition; the reach provider, the certificate monitoring, the reach screens and the verification checks that C7 names are not built. The specification is [contract C7](../../docs/contracts/c07-reach-providers.md).

## Exports

- `REACH_OPTION_IDS`, `ReachOptionId` and `REACH_OPTION_LISTENERS`: the options and their listeners.
- `REACH_STATES`, `ReachState`, `REACH_STATE_TRANSITIONS` and `ReachStateChange`: the states and the `reach/state` event.
- `ReachConfigRows`, `DEFAULT_SERVE_PORT`, `LISTENER_PORT_RANGE`, `DEFAULT_SERVE_CHECK_INTERVAL_MS`, `MIN_SERVE_CHECK_INTERVAL_MS`, `FUNNEL_PORTS` and `DEFAULT_FUNNEL_PORT`: the configuration rows.
- `TailscaleServeTarget`, `SERVE_SOCKET_PATH`, `SERVE_SOCKET_MODE` and `ServeSocketSpikeEvidence`: the serve target variants and the spike evidence.
- `TAILSCALE_HEADER_PREFIX` and `TAILSCALE_LOGIN_HEADER`: identity headers.
- `NAMED_CA`, `CAA_ENFORCED_PARAMETERS`, `RELAY_PATH_VALIDATION_METHOD`, `DELO_CONTROLLED_ZONES`, `CAA_CHECK_INTERVAL_MS` and `CERTIFICATE_RENEW_BEFORE_DAYS`: own-domain reach.
- `REACH_ERROR_CODES` and `ReachErrorCode`: the error codes.

## Limits

The package has no runtime code. It depends only on `@delo/contract-admission`, for the listener id and studio address types. A change to an option, a state, a row or a code follows the compatibility section of the contract.
