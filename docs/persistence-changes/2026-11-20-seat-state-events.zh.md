---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-20-seat-state-events

[English](2026-11-20-seat-state-events.md) | 中文

## 概述

Adds the Session events `external-agent/state`, `external-agent/status` and `external-agent/notice`, which log a live agent chat's program session and cursor, its status, and the notices its transcript shows.

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-20-seat-state-events
baseline: false
changes:
  - root: "event:external-agent/notice"
    previous: null
    after: "5dc496302380a2a4970aef02fd26cb5944472910a93e2ffa9a7f647882ffd55e"
    decision: same-version
  - root: "event:external-agent/state"
    previous: null
    after: "27679a813401a6e057a09142a38a62c8ee965d9b09a39e64a47db54a16aebcf2"
    decision: same-version
  - root: "event:external-agent/status"
    previous: null
    after: "33320a947d938827bb679963ee4089ea844acebb68517165b8917eae8c418b77"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

Three new event types; no existing event changes. They replace three ignorable plugin records of earlier previews (`plugin:delorun/agent-seat/state`, `/status` and `/notice`). The new events are required, not ignorable: a build that does not know them refuses the log, as it refuses any unknown required event type, instead of resuming a live agent chat as an ordinary chat that has lost its program session. A build with them reads every older log: the old plugin records are ignorable events of an unknown type, so it skips them, and the state they recorded is not recovered (the seat then shows its starting view and starts a fresh program session). Live agents sit behind an off-by-default preview flag, so such logs are unlikely. The fold version of the `agentSeat` projection rises, so a stored checkpoint built from the old records is discarded and refolded. The Session format version stays: the event type names are their discriminators.

<a id="verification"></a>
## 验证

pnpm exec vitest run delorun/packages/plugin-agent-seats/tests/state: a seat child restarted from its serialised log rebuilds the same view and logged state, the three events carry no ignorable marker, and a log holding the old plugin records reads without error and shows none of their state.

<a id="dev-note"></a>
## 开发备注

无。
