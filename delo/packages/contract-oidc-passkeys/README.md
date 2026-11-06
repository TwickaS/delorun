---
description: "Types-only package holding the identity factors, relying-party rules per reach address, passkey options, OpenID Connect flow parameters, required claims, allowed algorithms, enrolment routes, error codes, limits and spike evidence of the identity factors, as specified by contract C14."
---

# @delo/contract-oidc-passkeys

English | [中文](README.zh.md)

## Summary

This types-only package exports the definitions of the identity factors that reach asks for: the factor names, which reach options have passkeys under the current contract and how a relying-party ID is chosen, the passkey registration options, the OpenID Connect flow purposes and parameters, the client authentication and dynamic registration fields, the allowed ID token algorithms and required claims, the enrolment routes, the error codes, the limits and the evidence a `ts.net` spike report records. `@delo/home-auth`, setup and the reach screens import these definitions, so each rule and limit has one definition. The specification is [contract C14](../../docs/contracts/c14-oidc-passkeys.md).

## Exports

- `IDENTITY_FACTORS` and `IdentityFactor`: the factor names.
- `PASSKEYS_AVAILABLE`, `RELYING_PARTY_ID_RULE` and `RELYING_PARTY_NAME`: relying-party rules per reach option.
- `PASSKEY_COSE_ALGORITHMS` and `PASSKEY_REGISTRATION`: passkey options.
- `OIDC_CALLBACK_PATH`, `DELO_RUN_CALLBACK_PATH`, `OIDC_FLOW_PURPOSES`, `OIDC_FLOW_COOKIE`, `OIDC_AUTHORIZATION_PARAMETERS`, `OIDC_REAUTH_PARAMETERS`, `OIDC_CLIENT_AUTH_METHOD`, `OIDC_DYNAMIC_REGISTRATION` and `OIDC_CLIENT_FILE`: the OpenID Connect flow and client registration.
- `ID_TOKEN_ALGORITHMS`, `REQUIRED_ID_TOKEN_CLAIMS` and `PinnedOwnerIdentity`: ID token checks and the pinned owner identity.
- `ENROLMENT_ROUTES`: the routes an enrolment session reaches.
- `IDENTITY_LIMITS`, `IDENTITY_ERROR_CODES` and `IdentityErrorCode`: the limits and the error codes.
- `TsNetRelyingPartySpikeEvidence`: what a spike report records before passkeys become available on `ts.net` addresses.

## Limits

The package has no runtime code. It depends only on `@delo/contract-reach-providers`, for the reach option ids. A change to a rule, a claim, a limit or a code follows the compatibility section of the contract.
