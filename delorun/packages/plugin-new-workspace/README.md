---
description: "Delorun's new-workspace flow: add a folder, make a new one with Git, or clone from Git, each refused outside the configured roots and in the folders Delorun never adds, with each workspace's own starting model."
---

# @delorun/plugin-new-workspace

English | [中文](README.zh.md)

Delorun's new-workspace flow. Its Host half serves the routes the flow's screens call: where to start looking, a bounded folder search, one folder's preview, adding an existing folder, making a new folder with an optional Git repository, cloning from Git with an optional branch, and each workspace's defaults. It also starts each new chat in a workspace on that workspace's model. Its studio half is the dialog that calls the routes.

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

## The studio half

It loads only while the Delorun look is on; the stock look keeps upstream's flow. It occupies upstream's three directory-flow holes at priority -1, below upstream's pickers, so the sidebar's Add workspace, the new-chat workspace picker and the hero's workspace choice open the dialog and receive the workspace's folder as a picked folder, which upstream then adopts and opens. `ctx.delorunNewWorkspace.open({ from })` opens one large dialog, `min(1040px, 92vw)` by `min(720px, 88vh)` and full screen on a phone, and resolves `created` with the workspace's id, its folder and what the folder holds (`code`, `files` or `empty`; a new folder is `code` with Git, else `empty`), or `cancelled`. A second `open` while one is open resolves the first as `cancelled`. Closing the dialog never cancels a clone: it keeps running on the Host.

Screen 1 asks how to start (New folder, Folder on this computer, Clone from Git) and lists the recent workspaces, one click from use. Screen 2 depends on the card. The folder browser searches folder names, offers the suggested places, shows the crumbs of the listed folder and previews the selected folder beside the list; it also picks the place for a new folder or a clone, and on a phone shows one column at a time. The new-folder screen takes a name, a place and whether Git starts, ticked by default. The clone screen takes an address, an optional branch, a place and a name, and starts the clone, which keeps running while the next screens show. Continue on screen 2 goes to the model screen, and nothing is made yet.

Screen 3 is the model: "New chats here start with" a Model and a Thinking level, read from the studio's `remote.session` model catalogue and prefilled with the home's default ("<model> (your default)"). Thinking lists the levels the chosen model supports. When the catalogue cannot be read, the screen says chats start on the home's model and Continue still works. The workspace stores the model and level it shows whether or not the person changed them, so it keeps them if the home's default changes later; with no catalogue nothing is stored. Screen 4 is safety: Change files in this folder (selected, recommended) or Full access, which asks once for this workspace, and then Internet for commands: Open (default), Only sites I list (one host name per line, checked as host names and at most 200) or Off. Read only is not offered here. Both screens end with the same block about what one chat can switch (model, permission, and that the network stays for the whole workspace). Screen 3 offers Create now, which finishes with the choices made so far; the last screen's primary button is Create workspace. A recent workspace chosen on screen 1 is added as it is and keeps what it has.

Finishing makes the workspace and then sets it up in a fixed order, with "Setting up…" in the footer: first `.setDefaults` with the stored model (and the browser choice, once its screen exists), then, when the network is not Open, the home's own `POST /api/delorunNetwork.set` with `{ path, network: { access, hosts } }`, then, when Full access was chosen, `ctx.delorunFullAccess.askForWorkspace(path)`, and only then `created`. The path is the canonical one the Host returned. A step that fails is shown in place on a final view and the workspace still opens from its Open workspace button (closing the view opens it too); a declined consent leaves the workspace on Change files and opens it without a note, and a page without the consent service says to turn Full access on later from the permission menu in a chat. A refusal of the folder, name or clone returns to screen 2 with the reason.

Every screen opens with the safe choice already made. A route's answer is parsed with its wire schema, and a failure comes back as a value: `locked` asks the studio for the unlock prompt through `remote/call-denied`, `refused-arrival` says the step needs the computer, and each refusal shows in place as one sentence. Paths show the home folder as `~` and nothing else about the computer.

## Tests

`tests/routes.spec.ts` mounts the plugin and checks, for each route, the refused arrivals, the locked device and the computer. `create.spec.ts`, `clone.spec.ts`, `places.spec.ts` and `search.spec.ts` cover the home folder, the Delorun home, a folder outside the roots and a link leaving them; `defaults.spec.ts` covers the store's mode and format and the seed's conditions. The studio half's specs are `tests/*.client.spec.tsx` (the dialog, the API client and the service), `finish-flow.client.spec.tsx` (including the setup order) and `flow.spec.ts` (the flow's state machine); `setup.client.spec.tsx` covers the model and safety screens and the finish paths, and `models.client.spec.tsx` the catalogue mapping and host list.
