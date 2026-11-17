---
description: "The Host's plugin install queue: one list of plugin downloads and installs, run a configured number at a time, that survives a reload and applies one Host reload when it drains."
---

# @delorun/install-queue

English | [中文](README.zh.md)

## Summary

This package is the logic of the Host's install queue (owner decision A404). Every plugin download and install, a pack from the release channel or an existing plugin install, is one item in one list. The list is first come first served, runs a configured number of items at once, holds the same plugin once, and lets a person cancel a queued or working item. A failure stops only its own item. When the list has no queued or working item left, the Host reloads once for every finished install that needs it, and never while a chat runs.

The package holds no network, package-manager or Cordis code. The caller supplies the runner that downloads, verifies and installs one plugin, the reload, the count of running chats ([`ChatGate.running`](../home-process/README.md)), and the store that persists the list.

## Contents

- [States](#states)
- [Use this package](#use-this-package)
- [Tests](#tests)

## States

An item is `queued`, `downloading` (with bytes and total), `verifying`, `installing`, `needs-reload`, `ready`, `failed` or `cancelled`. A failed item carries a code (`offline` when the download could not start for lack of a connection, `interrupted` when the Host stopped during it, otherwise `failed`) and a sentence for the person. A queued item carries its place in the line.

## Use this package

Create an `InstallQueue` with the runner, `reload`, `runningChats`, `load` and `save`, call `restore()` once at start, `subscribe` to send every change to the studio, and call `chatsChanged()` when a chat ends so a reload that waited for the chats can run. `concurrency` is a validated `Config` field of the caller; a value below 1 or not an integer is refused at construction. `progressIntervalMs`, also a `Config` field of the caller, is the least time between two published byte reports of one item; the report that completes the download is always published. After a restart `restore()` fails an item that was working as `interrupted` and starts the queued ones again.

## Tests

`tests/queue.spec.ts` covers the line and its numbering, deduplication, progress, failure isolation, cancelling, the single reload, the wait for running chats, a failed reload, restoring after a restart and persistence.
