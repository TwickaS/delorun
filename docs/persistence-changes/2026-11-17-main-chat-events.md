---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-17-main-chat-events

English | [中文](2026-11-17-main-chat-events.zh.md)

## Summary

Adds the Session events `delorun-main-chat/read` and `delorun-main-chat/handoff`, and lists the `delorun-main-chat` message source that Delorun's plugin merges into the user, developer, inbox and title-request payloads; the persistence inventory now scans Delorun's plugin packages.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-17-main-chat-events
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "2b253f9a4fc062582ddbe3937a854574a51b5b191628a34922503e62a45e273a"
    decision: same-version
  - root: "event:delorun-main-chat/handoff"
    previous: null
    after: "f8766d88c0cb3dc9fecdb0caeb5b11266cbb441db82d8e8c82bf2ac2c68e4b65"
    decision: same-version
  - root: "event:delorun-main-chat/read"
    previous: null
    after: "514f7df060ae7775889b32b5c7003d63d978144a7e0c8483b0540239599713f6"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "70349a1c0566c4fd43925d3790e6afa57724b2c738b0b549b87acc105aef22c2"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "6130ff19041b0e8f56b81722f261ac05d2868107d497219d4b80fa248255ff71"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "68925d43dbdf9cde9fefd39e85d167cfda69d5a46103c6b516443c76c266c3cb"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The two events replace plugin records of the same meaning that earlier previews wrote under `plugin:delorun-main-chat/read` and `plugin:delorun-main-chat/handoff`. A build without them refuses to read a log that holds one, as it refuses any unknown required event type. A build with them reads an older log unchanged: the old plugin records are ignorable events of an unknown type, so it skips them, and a handoff or read they recorded is not recovered. The `delorun-main-chat` message source was already written by earlier previews; only the inventory now lists it, so no stored payload changes. The Session format version stays: the event type names are their discriminators.

<a id="verification"></a>
## Verification

pnpm exec vitest run delorun/packages/plugin-main-chat/tests/main-chat.spec.ts: the handoff is recorded as an event and read again after a restart, and an old plugin record is ignored without an error.

<a id="dev-note"></a>
## Dev Note

None.
