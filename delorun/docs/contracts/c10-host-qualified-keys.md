---
description: "Contract C10: the host id, the host-qualified key that the studio uses for its client state and browser storage, the inventory of persisted browser keys, and the rule that upstream ids and wire formats stay unchanged."
---

# Contract C10: host-qualified keys

English | [中文](c10-host-qualified-keys.zh.md)

<a id="summary"></a>
## Summary

The studio can hold connections to several homes, and two connections can share one browser origin. Host-qualified keys keep their client state and browser storage apart. Each connection has a host id, which the browser generates and never sends. A host-qualified key joins that host id with an upstream session or workspace id, and it names every persisted browser entry the studio writes. Upstream's ids, its request and response formats and its session events are unchanged, so no upstream client, SDK or stored session needs a new field. This page defines the host id, the key forms, the inventory of persisted browser keys and the rule that every persisted key carries a host id.

<a id="status"></a>
## Status

The key forms are built; no host id is ever set, so the studio writes every entry under upstream's stock name.

- **Built, reached by nothing:** `setPersistenceHostId` and `qualifiedPersistKey` in `packages/client/store`, which `ui-conversation`, `ui-schedule` and `ui-sidebar-right` use for their entries. Nothing outside tests calls `setPersistenceHostId`, and without a host id `qualifiedPersistKey` returns the bare stock name.
- **Built and reached:** a purge from the studio's Trash section removes the purged chat's draft entries under the bare name and under every host-qualified name in the browser that performs it.
- **Not built:** the studio's connection list and the creation of a host id per connection; host-qualified names for the shortcuts, terminal, user-question, workspace-view and sidebar-browser entries, which do not call `qualifiedPersistKey`; the rule that every persisted entry carries a host id and that stock entries are not read, since the studio reads and writes the stock names; the enumeration spec and the separation of two connections' browser state.

The requirements and denial tests below that this list names as not built or reached by nothing protect no one until a change builds and wires them.

<a id="contents"></a>
## Contents

- [Summary](#summary)
- [Status](#status)
- [Contract](#contract)
  - [Host id](#host-id)
  - [Host-qualified keys](#host-qualified-keys)
  - [Persisted browser keys](#persisted-browser-keys)
  - [Unchanged formats](#unchanged-formats)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)
- [Decided values](#decided-values)

<a id="contract"></a>
## Contract

<a id="host-id"></a>
### Host id

A host id identifies one studio connection to a home's Host process. The studio creates it when the person adds a connection, with upstream's `randomUuid`, and stores it in the studio's connection list in the browser. A host id is a lowercase UUID version 4 in the canonical 36-character form. It is unique within one browser profile and is never reused for another connection.

A host id is never sent. It does not appear in any request URL, header, cookie, RPC body, stream message or session event that the studio sends to a home. A host id does not encode the studio address, the home key or any other identity.

<a id="host-qualified-keys"></a>
### Host-qualified keys

A host-qualified key has one of two forms.

- Host scope: `<hostId>`.
- Upstream scope: `<hostId>.<upstreamId>`, where `<upstreamId>` is the session or workspace id exactly as the home issued it.

The persisted name of a browser entry is the entry's persist name from the inventory, followed by a dot and the scope. For example, the conversation state of one session on one connection is stored under `dsh.conversation.<hostId>.<sessionId>`. The host id has a fixed length, so a reader splits the key by taking the first 36 characters after the persist name, and the upstream id that follows is never parsed.

Generic stores follow the same rule. A store declared with `defineStore` and a `persist` name appends the scope key that its caller passes to `create` to the persist name. The studio creates every persisted store with a host-qualified scope key. A call to `create` without a scope writes under the bare persist name, which the inventory does not allow.

<a id="persisted-browser-keys"></a>
### Persisted browser keys

Every persisted browser entry carries a host id. The inventory below lists each entry the studio writes. Its `Scope` column states the form the entry uses. A new persisted entry is added to the inventory in the change that writes it.

| Persist name | Storage | Owner | Scope | Holds |
| --- | --- | --- | --- | --- |
| `dsh.keybindings.v1` | localStorage | `packages/client/shortcuts` | host | Keyboard shortcut overrides of the web studio. |
| `dsh.sidebar-right.v1` | localStorage | `packages/client/ui-sidebar-right` | host and session | Right sidebar state of each session. |
| `dsh.schedule.recent-time-zones.v1` | localStorage | `packages/client/ui-schedule` | host | Recently used time zones. |
| `dsh.schedule.task-tab.v1` | localStorage | `packages/client/ui-schedule` | host and session | Scheduled-task tab bindings of each session. |
| `dsh.conversation` | localStorage | `packages/client/ui-conversation` | host and session | Conversation view state of each session. |
| `dsh.conversation.contentWidth` | localStorage | `packages/client/ui-conversation` | host | Transcript width preference. |
| `dsh.terminal.binding.v1` | localStorage | `packages/api/terminal-controller` | host and session | Terminal bindings of each session and content. |
| `dsh.terminal.close.v1` | localStorage | `packages/api/terminal-controller` | host | Terminal close requests that have not completed. |
| `dsh.terminal.shell` | localStorage | `packages/api/terminal-controller` | host | Preferred shell. |
| `dsh.user-questions.drafts.v1` | localStorage | `packages/client/ui-user-questions` | host and session | Question composer drafts of each session. |
| `dsh.workspace.view.v5` | localStorage | `packages/client/ui-workspace` | host and the store's scope | Workspace view state. |
| `dsh.sidebar-browser.v1` | localStorage | `packages/client/ui-sidebar-browser` | host | Sidebar browser state. |
| `dsh.experimental-inspector.client-source-id.v0` and `dsh.experimental-inspector.client-source:` | localStorage | `packages/experimental/inspector` | host | Client source identifiers of the experimental inspector. |
| Review queue of the experimental forge | localStorage | `packages/experimental/client-ui-forge` | host and the caller's key | Review records, keyed by the caller's session and tab identity. |
| Any store declared with a `persist` name | localStorage | The package that declares the store | host and the scope the caller passes | The store's whole value as JSON. |

Cookies are outside this inventory. The Host sets the `dsh-auth-*` cookies, and the connection contract fixes their names. Each studio address has its own origin, so a cookie of one connection is not sent with another connection's requests.

A stock DeepSeek Harness entry written under a name without a host id is not read. Delorun does not migrate those values.

<a id="unchanged-formats"></a>
### Unchanged formats

Session ids, workspace ids, request and response bodies, RPC routes, stream messages and session events carry no host id. The studio sends each upstream id exactly as the home issued it. A host id appears only in client state and browser storage.

<a id="consumers"></a>
## Consumers

- The upstream client packages that write the entries in the inventory, which the studio changes to use host-qualified scopes: `packages/client/store`, `packages/client/ui-workspace`, `packages/client/ui-conversation`, `packages/client/ui-sidebar-right`, `packages/client/ui-schedule`, `packages/client/ui-user-questions` and `packages/api/terminal-controller`.
- `delorun/packages/trash/` and the studio's trash screen: a purge removes, in the browser that performs it, the draft entries of the purged chat under every host scope.
- `delorun/packages/plugin-workspaces/`: the client state of workspace import and `AGENTS.md` editing uses host-qualified scopes.
- The studio packages that create connections and stores.
- `delorun/packages/contract-host-qualified-keys/`: the host id type, the key forms and the inventory constant.

<a id="compatibility"></a>
## Compatibility

The host id format is fixed. Changing it changes every key that contains a host id, so a change that needs a new format also changes the persist name's version suffix, and it leaves the previous entries unread.

The inventory is additive. Adding an entry adds its row, its scope and its owner in the same change that writes it, and the spec that enumerates persisted keys fails on an entry that is not in the inventory.

Removing an entry from the inventory requires that no code writes it.

<a id="security"></a>
## Security

Requirements:

- A host id never leaves the browser.
- A host id does not reveal the studio address, a home key or any identity.
- A persisted entry holds no credential, token or cookie value.
- The studio reads an entry only under the scope of the active connection, so one connection's entries are not read through another connection.
- A purge under the trash contract removes the draft entries of a purged chat under every host scope in the browser that performs the purge. Drafts in another browser profile are not reached by that purge.

Denial tests:

| Test name | Behaviour proven |
| --- | --- |
| `persisted-key inventory refuses an undeclared key` | A persisted browser key that the inventory does not list fails the enumeration spec. |
| `persisted key without a host id fails the spec` | An entry written under a name without a host scope fails the enumeration spec. |
| `two connections with one upstream id keep separate browser state` | The same session id on two connections reads and writes two different entries. |
| `host id is absent from every request, response and session event` | A recorded session on a connection carries no host id in any request, response, stream message or session event. |
| `host id does not encode the studio address` | Two connections to one address with different host ids produce different entries, and the host id contains no part of the address. |
| `purge removes host-qualified drafts of a purged chat` | After purge in a browser, no draft entry for the chat remains under any host scope in that browser. |

Acceptance tests:

- `a spec enumerates every persisted browser key and asserts each carries the host id`.
- `upstream client specs pass with the host-qualified scopes`.

<a id="decided-values"></a>
## Decided values

- The host id is a lowercase UUID version 4 of 36 characters, created with `randomUuid`.
- The key separator is `.`, and the host id is always the first 36 characters after the persist name.
- Every persisted browser key carries a host id, and cookies are the only exception, because each studio address has its own origin.
- Stock entries without a host id are not migrated.
