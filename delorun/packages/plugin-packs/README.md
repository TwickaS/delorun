---
description: "Delorun's plugin packs on the Host: the install queue, the packs routes and the places other plugins call it."
---

# @delorun/plugin-packs

English | [中文](README.zh.md)

## Summary

A **pack** is a plugin that is not in the default install. Each release publishes its packs as separate signed files, and this plugin turns one on: it downloads the pack from the release channel, checks it against the release's signed packs file, installs it into the home, and loads it through the plugin manager. Every download and install, a pack or an existing plugin, is one item in the Host's install queue (`@delorun/install-queue`), so a person with many installs sees one list and one Host reload at the end.

## Contents

- [How an install runs](#how-an-install-runs)
- [The routes](#the-routes)
- [Reading progress](#reading-progress)
- [Configuration](#configuration)
- [Phones](#phones)
- [Where the Host connects it](#where-the-host-connects-it)
- [Limits](#limits)
- [Tests](#tests)

## How an install runs

1. The runner reads the installed release's packs file (`delorun-<version>.packs.json`), verifies it under the anchored root against the stored manifest and its release-log record, and finds the pack.
2. It downloads the pack's archive and any external npm packages, each only by the name or URL the packs file signs, with no redirect, stopping at the signed length.
3. The runtime store installs them under `store.lock`, seals the tree and records it; the start check and `delorun verify` hash every installed pack file again.
4. The plugin manager installs `link:<pack directory>` under the request id `pack:<name>`.

An item is `queued`, `downloading`, `verifying`, `installing`, `needs-reload`, `ready`, `failed` or `cancelled`. A failure carries a code: `offline` (the first download needs a connection), `interrupted` (the Host stopped during it) or `failed`.

## The routes

Each route is a `POST` with a JSON body, fetched relative to the document (`api/delorunPacks.<action>`; the paths are `PACK_ROUTES` in `@delorun/plugin-packs/wire`). `createPacksClient()` in `@delorun/plugin-packs/client` calls them and is what the downloads panel, Plugins and the setup guide use.

| Route | Arguments | Returns |
| --- | --- | --- |
| `list` | none | `PacksSnapshot`: `supported`, `reason`, `release`, `packs` (`PackInfo`: name, version, `experimental`, `downloadBytes`, `availability`) and `queue` (`InstallItem[]`) |
| `enqueue` | `{ names }` | `PacksResult` |
| `cancel` | `{ name }` | `PacksResult` |
| `dismiss` | `{ name }` | `PacksResult` |
| `remove` | `{ name }` (a finished, failed or cancelled item) | `PacksResult` |
| `retry` | `{ name }` | `PacksResult` |

`PacksResult` is `{ ok: true, value: PacksSnapshot }` or `{ ok: false, error: { code: 'unsupported' | 'unknown-pack' | 'unavailable-pack', message } }`. The types and `packView(pack, item)`, which maps a pack and its queue item to what a surface draws, are in `@delorun/plugin-packs/wire`, which imports no Cordis.

## Reading progress

The plugin announces every item of the list on the plugin manager's `plugin-manager/install-state` event under the request id `pack:<name>` after each change. A surface listens for that event and calls the `list` route for the bytes, percent, state and queue position; it also reads the whole list when it connects.

## Configuration

`concurrency` (default 2, at least 1) is how many installs run at once. The queue is saved in `run/<profile>/installs.json` at mode 0600 in the Delorun home, so a page reload or a Host restart finds it; a restart fails a working item as `interrupted` and starts the queued ones again.

## Phones

The `list`, `cancel` (stops a queued or downloading install) and `dismiss` (clears a failed or cancelled row, a queue record only) routes answer any approved phone; neither touches an installed pack (A408). The `enqueue`, `retry` and `remove` routes answer a phone only while it holds an unlock, and a phone without one is answered `403`, which the client turns into the unlock dialog's `elevation-required: packs/<route>` (A408).

## Where the Host connects it

- The `delorunChatGate` service takes the Host's chat gate (`ChatGate.running`) from `delorun`'s Host wiring, so the single reload waits until no chat runs.
- The `packInstallTargets` service lets the plugin manager's official installs resolve an installed pack to its `link:` spec.
- `delorun update` installs the new release's version of every added pack before it switches; `delorun recover packs` hashes the installed packs again and fetches a changed one again. A rollback keeps `packs/<previous>/`.

## Limits

- A release channel that answers a download with a redirect, as GitHub Releases does, fails the pack download. Try one real download from each channel before a release.
- A Host with no installed release (a source checkout) lists no packs and says why.

## Tests

`tests/hub.integration.spec.ts` covers listing, install, the single reload, offline, cancelling and restoring over a signed release fixture. The store, transport, update, rollback and repair specs are in `packages/runtime-store/tests/`, and the phone rules are in `packages/home-auth/tests/reach-access.spec.ts`.
