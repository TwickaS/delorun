---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-17-run-allowed-event

English | [中文](2026-11-17-run-allowed-event.zh.md)

## Summary

Adds the Session event `external-agent/run-allowed`, which records that the person answered a live agent's question with "Allow for this run" and the start gate kept the program's rule, naming the question's `approval/asked` event.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-17-run-allowed-event
baseline: false
changes:
  - root: "event:external-agent/run-allowed"
    previous: null
    after: "0c201d883a00e1f807504b13aaffc6aeee8b9d0b654e5a16f49b2975fa0b31fe"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

One new event type; no existing event changes. A build without it refuses to read a log that holds one, as it refuses any event type it does not know, rather than replaying the chat without the record. A build with it reads every older log unchanged, since older logs hold none. The event is log-only audit: no reader derives state from it, so a build that knows it ignores its absence. It keeps the Session format version: its type name is its discriminator.

<a id="verification"></a>
## Verification

delorun/packages/plugin-agent-seats/tests/relay.spec.ts appends the event through the relay on a real Session store and approval service: it names the question's approval/asked event once the consent service holds the rule, and nothing is logged for Allow once or when the gate falls back to Allow once.

<a id="dev-note"></a>
## Dev Note

None.
