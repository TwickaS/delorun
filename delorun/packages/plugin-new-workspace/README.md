---
description: "Delorun's new-workspace flow: add a folder, make a new one with Git, or clone from Git, each refused outside the configured roots and in the folders Delorun never adds, with each workspace's own starting model."
---

# @delorun/plugin-new-workspace

English | [中文](README.zh.md)

Delorun's new-workspace flow. Its Host half serves the routes the flow's screens call: where to start looking, a bounded folder search, one folder's preview, adding an existing folder, making a new folder with an optional Git repository, cloning from Git with an optional branch, and each workspace's defaults. It also starts each new chat in a workspace on that workspace's model.

## Routes

Every route is an exact `POST` under `/api/delorunNewWorkspace`, served while upstream's workspace registry is present. Each answers the computer, and a paired device only while it holds an unlock (`ELEVATION_REQUIRED` otherwise); any other arrival is refused `LOOPBACK_REQUIRED` before the body is read. The four routes that change something (`add`, `create`, `clone`, `setDefaults`) renew the device's unlock.

| Route | Body | Answer |
| --- | --- | --- |
| `.places` | none | The recent workspaces whose folders still exist, the suggested folders that exist inside a root, the home folder, and where a new folder goes. |
| `.search` | `{ query }`, 1 to 100 characters | Up to 50 folders whose name contains the query (any letter case), nearest first, and why the search stopped: `complete`, `limit` or `time`. |
| `.preview` | `{ path }` | Whether the folder is empty, code or files, whether it is a Git repository and on which branch, whether it has an `AGENTS.md`, and its first 24 visible names, folders first. |
| `.add` | `{ path }` | `added` with the workspace's id, canonical path and kind, or `refused` with the reason. |
| `.create` | `{ parent, name, git }` | Makes `parent/name` and registers it; with `git` it runs `git init` and writes a starter `.gitignore`. |
| `.clone`, `.cloneStatus` | `{ url, parent, name, branch? }`, then `{ job }` | Starts a clone into `parent/name` and reports its progress, then registers the folder. |
| `.defaults`, `.setDefaults` | `{ path }`, then `{ path, defaults }` | One workspace's model, thinking level and browser choice. |

## Where a workspace may go

Every path is checked twice: against the folders Delorun never adds (the home folder itself, the Delorun home, the stock home and the system folders `workspaceLocationProblem` of `@delorun/home` lists), and, for a search, a preview, a new folder or a clone, against the configured `roots` with symbolic links resolved. A new folder's or clone's parent is created when missing and checked again after it exists, so a link planted in the meantime is refused. A refusal names the reason and creates nothing.

A preview reads the folder's top-level names and `.git/HEAD` only, at most 2000 entries within `searchTimeMs`; it opens no other file and follows no link. A search walks breadth-first from each root, at most `searchDepth` folders deep, `searchFolders` folders and `searchTimeMs` long. It never follows a link and skips hidden folders, dependency and build folders (`node_modules`, `vendor`, `dist`, `target`, `venv` and similar), the Delorun home and the stock home.

## Git

`create` and `clone` run Git with hooks, LFS filters and the person's templates off, and with no system or global configuration, askpass program or terminal prompt. A clone takes `https` addresses without a user name or password, and `ssh` and scp-like addresses; it skips submodules, and checks out with every `filter` attribute unset; `.git/info/attributes` is removed once it finishes. A branch name is checked against Git's rules before Git runs. `@delorun/plugin-workspaces`' import clone builds its arguments from the same `cloneArguments` and `createCloneTemplate`.

## Each workspace's model

`.setDefaults` keeps one workspace's model (`provider`, `model`, optional `reasoningEffort`) and browser choice in `<Delorun home>/secrets/new-workspace/defaults.json`, mode 0600, keyed by the folder's real path, under a lock file. The same file keeps the last folder a new folder or clone went in, which `.places` offers as the next place.

When a top-level chat starts in a workspace whose defaults hold a model, the plugin appends upstream's `model/selection` event before the first request, so the chat's log records the model it starts on. A resumed, forked or delegated chat, a chat that already records a model, and a workspace whose model's provider is not connected are left alone; the last one is logged.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `roots` | `['~']` | Where new folders and clones may go and where a search looks. |
| `suggested` | `~/Projects`, `~/src`, `~/code`, `~/Documents`, `~/Desktop` | Folders offered as places to start, when they exist inside a root. |
| `firstParent` | `~/Projects` | Where a new folder or clone goes before the person has made one; created at first use. |
| `searchDepth` | 4 | Folders below each root a search looks. |
| `searchFolders` | 20000 | The most folders one search reads. |
| `searchTimeMs` | 2000 | The most time one search or one preview read takes. |
| `cloneTimeoutMs` | 600000 | The most time one clone takes. |

## Tests

`tests/routes.spec.ts` mounts the plugin and checks, for each route, the refused arrivals, the locked device and the computer. `create.spec.ts`, `clone.spec.ts`, `places.spec.ts` and `search.spec.ts` cover the home folder, the Delorun home, a folder outside the roots and a link leaving them; `defaults.spec.ts` covers the store's mode and format and the seed's conditions.
