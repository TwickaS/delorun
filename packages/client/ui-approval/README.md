---
description: "Browser approval UI that answers Host permission requests through the scoped interaction path."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-approval

English | [中文](README.zh.md)

## Summary

Browser approval presentation over the Agent-scoped Remote Event waterfall. The plugin publishes each pending request through `ctx.uiSession`, takes over the Conversation composer, optionally renders correlated Tool detail, and returns the user's decision to the waiting Host request. Use it when a browser must collect approval for a waiting Host operation.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

Focus the approval detail region to approve with Enter or reject with Escape. The mounted plugin reserves both keys against editable shortcuts. Enter on the focused Reject button retains its native reject action. Input controls and IME candidates keep their own keys. Keyboard and pointer actions share one pending-request lock; a withdrawn or replaced request cannot accept another answer, and an earlier failed answer cannot unlock its replacement.

When offered, **Always allow** is the highlighted primary button. Otherwise, the current-request allow action is primary. Enter in the detail region always grants the limited scope: once for a tool approval, or the current session for CUA. Persistent access requires explicitly activating Always allow. The shortcut reference uses Allow because the caller supplies that scope.

<a id="model-experience"></a>
## Model Experience

None, as this package presents approval requests in the browser and registers nothing model-facing.

#### KV Cache effect

None; approval request and response rendering does not alter a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The shared `conversation.approval.card` Factory presents reject, allow and an optional always-allow action, with caller-owned scope, subject metadata and answer callbacks. Tool approvals retain their two outcomes. Application consent can reuse the card without adopting tool-approval policy. Subject metadata enables left-aligned content and wrapping actions; callers that omit it retain inherited alignment and a single action row. Icons and labels identify the subject visually; the caller owns identity verification and saved grants.
- A request's `grants` (`full-access` or `workspace-management`) reaches the pending approval and the card. For such a request the card renders the Session-scoped `conversation.approval.action` list between its detail and its buttons; each entry receives `grants`, `toolName`, `callId`, `allow()`, which answers the card through the same one-shot lock as its Allow button, `answered`, true while the card sends or has sent an answer, and `canAnswer()`, false from then on and once the request no longer accepts an answer, which an entry with effects of its own reads before each effect. A request without `grants`, or a list without entries, leaves the card unchanged.
- A request's `escalatesTo` (`workspace-write` or `danger-full-access`, set by a shell-command or file-operation sandbox escalation) reaches the pending approval and the card. For such a request the card renders the Session-scoped `conversation.approval.choice` list in its decision row after Allow once; each entry receives `escalatesTo`, `toolName`, `callId`, `allow()`, `answered` and `canAnswer()` as an action does, and `offer(shown)`, with which it reports whether it shows a button. While an entry reports one, Allow once draws as a secondary button so the choice is the primary one. A request without `escalatesTo`, or a list without entries, leaves the card unchanged.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
