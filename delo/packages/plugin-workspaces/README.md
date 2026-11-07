---
description: "The workspaces provider behind the main chat's account tools, for maintainers changing how Delo creates, imports, reads, trashes and restores workspace folders under one root, and which token a clone host receives."
kind: "package-bundle"
---

# @delo/plugin-workspaces

English | [中文](README.zh.md)

## Summary

`@delo/plugin-workspaces` provides the `deloWorkspaces` service, whose [Service Definition](src/service.ts) the main chat's account tools call. It creates empty workspace folders under one configured root, imports a repository into a new folder with `git clone`, reads and writes a workspace's `AGENTS.md`, and moves a folder with the workspaces in it to `root/.delo-trash` and back. Each workspace is an entry of upstream's workspace registry; the trash unregisters the workspaces it moves and registers them again on a restore. Imports and trash rows live in the plugin's own storage domain, so they survive a restart. The stock composition does not mount the plugin; Delo's studio bundle mounts it with its configuration.

## Contents

- [Contract](#contract)
- [Configuration](#configuration)
- [Carry-forward review](#carry-forward-review)
- [Known limitations](#known-limitations)
- [Tests](#tests)

## Contract

- **Create.** `create` makes `root/<directory>` with mode 0755, less the umask, and registers it with `title`, which defaults to the folder name. The name must be a folder name: a letter or digit, then up to 99 letters, digits, dots, underscores or hyphens. A name that is not one answers `invalid`, and an existing folder answers `taken`. When the registry refuses the new folder, the empty folder is removed and the call answers `failed`.
- **Import.** `startImport` accepts only an `https` URL without a user name, password, query or fragment ([`cloneUrlProblem`](src/git.ts)), and refuses any other URL as `invalid` before a process starts. The folder is the request's name, or else the URL's last path segment without `.git`. The call records an import row and answers its id and folder at once. The clone runs in the background through upstream's `subprocess` service ([`cloneRepository`](src/clone.ts)), for at most `importTimeoutMs`. A clone that succeeds registers its folder as a workspace titled with the folder name, and the row becomes `done` with that workspace. A clone that fails, or passes its time limit, removes the folder unless a workspace holds it, and the row becomes `failed` with git's reason, redacted, or with `the clone took longer than N minutes`. While a clone runs, `list` shows git's latest progress line.
- **Instructions.** `instructions` reads the workspace's `AGENTS.md` and answers its path, its text, the SHA-256 of its bytes as the revision, and the byte limit. `setInstructions` writes the file, or removes it for empty text, only when the file still has the revision given; `null` names a missing file. A different revision answers `conflict`, and text over the limit answers `too-large`. An unknown workspace answers `not-found`, and a workspace outside the root answers `outside`. The file is opened through `/proc/self/fd` with `O_NOFOLLOW` ([`files.ts`](src/files.ts)), so instructions work on Linux only; other hosts answer `failed`.
- **Trash.** `trash` moves the folder that holds a workspace, with every registered workspace under it, to `root/.delo-trash/<id>`, a folder of mode 0700, and unregisters those workspaces. Before the move, each of their chats that is not archived is archived with `stopActivity`, which asks the chat's running work to stop. A failure before the move changes nothing and unarchives the chats this call archived. The trash row keeps each workspace's title, path, chats in order and archived chats, and expires at the trash time plus `trashDays`.
- **Restore.** `restore` moves the entry's folder back under its recorded name. It answers `taken` when that name exists again, and `not-found` when the entry or its folder is gone. It registers each workspace again with its title, creating the last one first so the registry keeps the recorded order, reattaches the chats in their recorded order, and unarchives the chats the trash archived.
- **Sweep.** `list` and the plugin's start remove trash entries past their expiry and entries whose folder is gone, and delete finished imports older than a day. An import the process is not running is settled: a folder that a workspace holds makes its import `done`, and any other folder is removed while the import becomes `failed` with `the harness restarted while it cloned`.
- **Credential.** With `credential: { host, file }`, a clone whose URL host equals `host` receives the token that `file` holds, read for that clone. The host includes a non-default port. The token file must sit directly in the home's `secrets` directory and pass the protected-file check when the plugin loads, or the load fails. The token reaches git through a credential helper that answers only for the clone URL's host and path ([`git.ts`](src/git.ts)). It is never in argv, the stored URL, the import row, `.git/config` or a log line, and every reason a clone reports passes through redaction with the token.
  - **Residual.** While git runs, the token is in git's environment and in the environment of the processes git starts. A process of the same user can read it there, for example through `/proc/<pid>/environ`, until the clone ends.
- **Root and home.** The root is made canonical and created at load. A root that is the Delo home, lies inside it or contains it fails the load, so the home is never inside a writable root. The home is resolved by [`resolveDeloHome`](../home/src/resolve.ts).
- **Errors.** Every refusal is a `WorkspaceRefusedError` with one of the codes in [`service.ts`](src/service.ts). An unexpected failure answers `failed` with its error code, or `unexpected error`; that message names no path and no credential, and the failure is logged.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `root` | required | The absolute directory that holds the workspace folders and the trash; created at load when it is missing. |
| `trashDays` | 30 | How many days a trashed folder is kept, from 1 to 3650. |
| `instructionsMaxBytes` | 65536 | The longest `AGENTS.md` read or written, in UTF-8 bytes, from 1 to 16 MiB. |
| `importTimeoutMs` | 1800000 | How long a clone may take, in milliseconds, from 1000 to 86400000. |
| `credential` | none | `host` and `file` together: the clone host that receives the token, and the token file directly in the home's `secrets` directory. |
| `caFile` | none | The CA bundle git trusts for every clone. It replaces the system bundle, so it must include the public roots too. |

## Carry-forward review

The package carries the workspace operations of the earlier implementation (V4), reviewed for this tree.

- **Carried:** creating a folder and removing it when the registry refuses it; the clone's arguments, redaction and progress lines, now in [`clone.ts`](src/clone.ts) and [`git.ts`](src/git.ts); the import rows with their progress kept in memory; the trash with its archived chats, unarchived on a failed move; the restore's re-registration and chat reattachment; the sweep of expired trash, finished imports and imports a restart left; the instructions reads and writes against a revision, rebuilt in [`files.ts`](src/files.ts); the time limit and the cancellation at disposal.
- **Adapted:** the token comes from a configured credential file for one host, read per clone, where V4 minted a GitHub token per clone through account control; the folder name is the URL's last segment without `.git`, with no percent-decoding, because the URL check already refuses the characters a folder name cannot hold; a restore creates the last workspace first, since the registry prepends each one, where V4 created them in recorded order and reversed the display order; the restart sweep also settles a folder a workspace already holds as `done`, which the crash between the registration and the row write leaves; failures carry an error code, not an HTTP status, because the routes now belong to the studio.
- **Cut:** the cell's command runner, its container removal, its main-chat home and the runner protocol's names, because a workspace is a folder of the root and needs no container; account control's GitHub token minting, revocation and repository list, because Delo holds no GitHub keys and the credential file replaces them; the secret names of a folder, which account control keeps; the Connection routes and their JSON wire, which the studio binds to the service; the strict re-validation of the configuration, which the schema at load already performs.

## Known limitations

- `AGENTS.md` reads and writes need Linux, since they open names through `/proc/self/fd`; on other hosts they answer `failed`.
- The token's exposure during a clone is the residual in the contract: a process of the same user can read git's environment until the clone ends.
- A trash stops the running work of the chats it archives, and the stopped turn is not resumed by the trash.
- A crash between the archive and the move leaves the chats archived; the trash row is forgotten at the next sweep when its folder is gone, and the chats stay archived.
- A restart keeps git's progress line only in memory, so the line is gone after a restart.
- The credential file is read for each clone, so a rotated token takes effect at the next clone; a file that is no longer private fails that import with `the credential file is refused`.
- A workspace registered outside the root answers `outside` and is never moved by this package.
- The package serves no routes; the main chat and the studio reach the service through `deloWorkspaces`.
- The stock composition does not mount the plugin, and [`cordis.patch.yml`](cordis.patch.yml) has no configuration, so a bundle must supply `root`.

## Tests

[`tests/workspaces.spec.ts`](tests/workspaces.spec.ts) mounts the real composition over a JSON storage directory: the storage hub, the storage domain, upstream's workspace registry and the provider. It covers creation and its refusals, the instructions through the service, the configuration refused at load, imports from the local HTTPS git fixture ([`tests/fixtures/git-server.ts`](tests/fixtures/git-server.ts)) with the credential rules, the restart settlement, the trash, the restore order and the purge. [`tests/files.spec.ts`](tests/files.spec.ts) covers the instructions walk: links, FIFOs, directories, sizes and the revisions. [`tests/clone.spec.ts`](tests/clone.spec.ts) and [`tests/git.spec.ts`](tests/git.spec.ts) cover the clone step and the git options. The fixture serves a public repository, a private repository that needs its token, and a repository whose advertisement never arrives, so a clone waits until it is stopped. The specs run on Linux and need `openssl` on the path for the fixture's certificate.
