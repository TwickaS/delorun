---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-17-real-browser-grant-events

English | [中文](2026-11-17-real-browser-grant-events.zh.md)

## Summary

Adds the Session events `real-browser/granted`, `real-browser/away` and `real-browser/ended`, which record a chat's grant to use the person's own browser, the permission for runs the person did not start to use it, and its end.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-17-real-browser-grant-events
baseline: false
changes:
  - root: "event:real-browser/away"
    previous: null
    after: "a20ee5ade286773dec82ee1b5bfa0ca3bc7f5de8a9a5645b88589de5572347e0"
    decision: same-version
  - root: "event:real-browser/ended"
    previous: null
    after: "8cc928f857619a6ecd26bb2e2ae08d84ba320b74ddae35c287d36afa65de61a5"
    decision: same-version
  - root: "event:real-browser/granted"
    previous: null
    after: "23afe2b636b2258c47a86a1ec92709a9494737b1e99e61fdf62f4b0d37b3ccb1"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Three new event types; no existing event changes. A build without them refuses to read a log that holds one, as it refuses any event type it does not know, rather than replaying the chat without its grant. A build with them reads every older log unchanged, since older logs hold none. The events keep the Session format version: their type names are their discriminators.

<a id="verification"></a>
## Verification

`delorun/packages/browser-use-browse/tests/grant.spec.ts` records each event through the agent loop and the approval service and folds them with the `realBrowserGrant` projection, including a forked Session that starts without its parent's grant.

<a id="dev-note"></a>
## Dev Note

None.
