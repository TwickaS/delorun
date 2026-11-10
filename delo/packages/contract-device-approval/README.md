---
description: "Types-only package holding the key types, owner claim and approval messages, match code parameters, recovery kit, TLS key statement, alert kinds, error codes and limits of device approval, as specified by contract C5."
---

# @delo/contract-device-approval

English | [中文](README.zh.md)

## Summary

This types-only package exports the messages and limits of device approval: the key algorithms and the files that hold them, the owner claim, the approval request and its answer, the approval with its WebAuthn or re-authentication proof, the session request, the recovery kit prefix, the desktop app's TLS key statement, the alert file and its kinds, the error codes and every limit as a named constant. `@delo/home-auth` and `@delo/archive` import these definitions, so each message field and limit has one definition; the certificate monitoring, the reach screens and the desktop app's side that C5 names are not built. The specification is [contract C5](../../docs/contracts/c05-device-approval.md).

## Exports

- `DEVICE_APPROVAL_VERSION`, `Base64Url`, `HomeKeyId` and `ApprovalRequestId`: the message version and the branded values.
- `KEY_ALGORITHMS`, `HOME_AUTH_FILES` and `BROWSER_DEVICE_KEY_STORE`: the key types and where they are stored.
- `OwnerClaim`, `ApprovalRequest`, `ApprovalRequestAccepted`, `APPROVAL_REQUEST_STATES`, `Approval` and `WebAuthnAssertion`: the claim and approval messages.
- `MATCH_CODE_LABEL` and `MATCH_CODE_DIGITS`: the match code derivation's label and length.
- `SIGN_IN_LABEL`, `IdentityFactorProof` and `SessionRequest`: sign-in.
- `RECOVERY_KIT_PREFIX` and `TlsKeyStatement`: the recovery kit's written form and the desktop app's pin statement.
- `ALERT_KINDS`, `BLOCKING_ALERT_KINDS`, `AlertFile`, `ALERT_WEBHOOK_URL_FILE`, `ALERT_SIGNATURE_HEADER` and `ALERT_COMMAND_ENV`: alerts and their channels.
- `DEVICE_APPROVAL_LIMITS` and `DEVICE_APPROVAL_ERROR_CODES`: the limits and the error codes.

## Limits

The package has no runtime code. It depends on the workspace brand package and on `@delo/contract-admission` for the device id and studio address types. A change to a message, a limit or a code follows the compatibility section of the contract.
