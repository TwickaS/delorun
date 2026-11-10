---
description: "Summarize each top-level turn's changed files from git working-tree snapshots and whole-file captures around file-tool edits, announce them with a workspace/changes Session event, and serve the summary and per-file comparisons while the Session lives; configuration, repository requirement, and coverage rules."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-changes

English | [中文](README.zh.md)

## Summary

This plugin summarizes which files each top-level turn changed, with per-file line counts, and serves each listed file's turn-start and turn-end comparison. Git snapshots of the working tree at turn start and turn end are diffed; every file a file tool edits is copied whole before its first edit and again at turn end, covering the files git does not. Without a repository or git, only file-tool edits are listed. The Session log receives one `workspace/changes` event naming the turn; summaries and comparisons stay on the Host until the Session is disposed. The Web changed-files card renders them.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The shipped Web bundle mounts this plugin. Mount it in any composition with the `subprocess` capability and a git executable on the Host:

```yaml
- name: '@deepseek-ai/dsh-workspace-changes'
  config:
    maxFiles: 500
```

| Field | Default | Meaning |
|---|---|---|
| `timeoutMs` | `30000` | Milliseconds one git command may run before the turn's record is abandoned |
| `outputMaxBytes` | `8388608` | Bytes of git output retained per command; a larger diff listing abandons the record |
| `maxFiles` | `500` | Maximum files carried by one summary; `total` still reports the complete count |
| `maxFileBytes` | `2097152` | Bytes a file may hold to be captured around a file-tool edit or read from a snapshot for its comparison; a larger file gets no comparison, and one captured around a file-tool edit is also listed without counts |
| `diffTimeoutMs` | `100` | Milliseconds a line comparison may run before it degrades to whole-file replacement |
| `scratchRoot` | the per-user cache directory's `dsh-workspace-changes` | Absolute directory that holds each Session's private directory; see [Private directory](#private-directory) |

This plugin requires the `subprocess` and `fs` services. When the composition also mounts `sandbox` and `sandboxPolicy`, each git command over a Session's repository runs in that Session's sandbox, as its own commands do: under `workspace-write` with the Session's writable roots plus the Session's private directory, under `read-only` with only that private directory writable, and unconfined under `danger-full-access`. A command the sandbox cannot confine fails that turn's record, as does a command of a confined Session while no sandbox is mounted and any command while a sandbox is mounted without its policy; it never runs unconfined. Whether confined or not, every git command runs with the hardened configuration described under [Git hardening](#git-hardening), so repository state a model command can write starts no program. Git older than 2.31 counts as absent, because it ignores that configuration.

Every Session with a working directory and no subagent origin is recorded; subagent Sessions are not. Snapshots are written through a private index into an object directory inside the Session's [private directory](#private-directory), with the repository's own object store attached as a read-only alternate; the repository's index, objects, work tree, and refs stay untouched, and the user's earlier uncommitted changes never enter a summary. Session disposal removes the directory. Nested repositories and submodules inside the working directory are recorded as gitlinks, so their internal changes do not appear. A working directory outside any git repository takes no snapshots. Without git — or, on macOS, with only the developer-tools stub at `/usr/bin/git` — no repository is located either, and the plugin logs that once. Either way the summary lists the file-tool edits alone, as described next, with the working directory as the workspace; shell edits are absent.

After a `write`, `edit`, or mutating `str_replace_editor` call resolves its target and obtains its mutation guard, the recorder copies that exact file before the mutation into the Session's private directory, once per path per turn, and copies it again at turn end; the copies are named by the SHA-1 of their bytes, so identical content is stored once. This needs no git. Repository discovery and display paths retain the original project; file captures follow the operation's resolved target even after the Session changes directories. Paths the snapshots cover keep their git counts; the copies serve the other paths — files matching an ignore pattern, files outside the repository, and every file-tool edit when there is no snapshot — with counts from a line comparison of the two copies, so repeated edits to one file count once and a shell edit after a file-tool edit is included. A path whose content is unchanged at turn end is not listed. A copy larger than `maxFileBytes` is not stored: the file is listed with `oversized` and no counts, and a path whose both sides are that large is listed too, since unread content is never known to be unchanged. A path whose only difference is a missing final newline compares as unchanged, while git still counts that line. Files under `/tmp` or the platform temporary directory are excluded unless they lie inside the repository. Changes made only through shell commands outside the snapshot coverage are not recorded.

Each file carries a durable `path` — relative to the working directory inside it, absolute elsewhere — and a `display` path used for ordering and labels: the relative path, a `../` path for repository files above the working directory, a `~` path under the home directory, otherwise the absolute path. Files sort by `display` in code-unit order, which lists parent and absolute paths before the working directory's own files. The `workspace/changes` event carries only the turn number; `ctx.workspaceChanges.summary(sessionId, seq)` returns the summary the event with that sequence announced, or undefined once the Session is disposed or when this Host process never recorded it. `ctx.workspaceChanges.diff(sessionId, seq, index, signal)` compares the listed file at that index: hunks with three context lines from the two snapshot trees or the two copies, `binary` for a side git reported as binary or that holds a NUL byte, `oversized` for a side larger than `maxFileBytes`. A line comparison that runs longer than `diffTimeoutMs` degrades to one hunk replacing every line, marked `coarse`. A conversation reopened after a Host restart therefore has no card, and no comparison, for its earlier turns.

The intent listeners capture every add, update, delete, and move target of `apply_patch` after policy admission and before provider mutation; a move captures both ends. Review compares each path against its first baseline and lists net changes, including the completed effects of a stopped patch.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One `TurnRecorder` per Session serializes its git work. `turn/start` queues the baseline: `rev-parse` locates the repository once per Session and the object directory is created in the Session's private directory, then `add --all --ignore-errors` into a scratch index seeded from the repository's index and `write-tree` produce the tree id; an unreadable file is skipped and reported through git's exit code 1, which the snapshot accepts. Each turn holds its own state object, so a record still running for an interrupted turn keeps that turn's files when the next turn starts. Every command runs with `GIT_OBJECT_DIRECTORY` pointing at the private object directory and `GIT_ALTERNATE_OBJECT_DIRECTORIES` at the repository's objects, so committed content is read from the repository and new objects never land there. Every `tools/pre-execute` waits for that queue before a tool runs, so no mutation can precede its baseline; the filesystem's `fs/write-intent`, `fs/edit-intent`, and `fs/delete-intent` waterfalls delegate the guard decision, then queue and await the capture of the resolved target before mutation, and `tool/result` events only mark that the turn has results to record. `agent/turn-stopping` records inside the turn: a second snapshot, `diff-tree -r -M --numstat` between the two trees, `check-ignore` for captured paths inside the work tree, a second copy and line comparison of each uncovered path, the appended event, and the summary kept under the event's sequence beside each listed file's two content sources, a path in a snapshot tree or a copy. A comparison is computed when asked for: `ls-tree -l` locates and sizes a snapshot side and `cat-file blob` reads it under `maxFileBytes`, copies are read from disk, and both sides go through the same line comparison with its timeout. `turn/end` records again only when tool results settled after the last record attempt, which covers aborted, failed, and steered turns without repeating a failed attempt; an empty list after an earlier record supersedes it. The repository's index is only read.

Git runs through the `subprocess` capability, wrapped by the Session's sandbox as described above, with the configured timeout and bounded output. A wrapped command whose stderr matches the sandbox's runner-failure rules fails as an unavailable sandbox instead of being read as a git result. A failing step abandons that turn's record with a warning; the next turn starts afresh. Session disposal and plugin disposal abort queued work, forget the summaries, and remove the private directory.

</details>

<a id="private-directory"></a>
### Private directory

Each Session gets a new directory with mode 0700, named `session-`, the Host process's id, `-` and a random suffix, inside `scratchRoot`. It holds the snapshot object store (`objects/`), one scratch index per snapshot (`index-*/index`), and the captured copies (`captures/<sha1>`). By default `scratchRoot` is `dsh-workspace-changes` in the per-user cache directory: `$XDG_CACHE_HOME`, or `~/.cache` when that variable is unset or relative, on Linux and other POSIX systems; `~/Library/Caches` on macOS; `%LOCALAPPDATA%` on Windows. The root and its missing ancestors are created on first use; the root must be a directory owned by the current user, not a link, and is narrowed to mode 0700. At load the plugin removes the `session-<pid>-*` directories, not links, whose Host process is no longer running; it first requires the root to be a directory, not a link, owned by the current user and overlapping no live Session's writable root, and otherwise removes nothing and logs a warning.

No sandbox dialect lets a Session's confined commands write there. Under `workspace-write`, bwrap binds only the workspace and the extra writable roots over a read-only root file system and gives commands a private `/tmp`; Landlock and Seatbelt grant those roots plus the Host's `/tmp` and platform temporary directory. A cache directory lies in none of them unless a workspace or extra root contains it. The directory cannot sit in the sandbox's protected home instead, because confined git commands must be granted it as a writable root and the sandbox refuses a writable root that overlaps the protected home. Before each snapshot and each stored copy, the recorder compares the private directory, by path segment in both directions, with every root `writableRoots` reports for every live Session the session store holds and every Session being recorded, resolved through each one's policy; on an overlap the turn records nothing and the plugin logs a warning. A Session under `read-only` contributes no root, and one under `danger-full-access`, or any Session without a sandbox policy, runs its commands with the Host's authority, so no directory is out of their reach and none is compared. A command a Session runs through an approved full-access escalation is not covered.

The recorder remembers the device and inode of the scratch root, the private directory and every directory it creates in it, and checks each with `lstat` before every git command, index copy, capture, read and removal: one that is missing, is no longer a directory or has another device or inode, such as a directory or a parent renamed away and replaced by a link, fails the operation, and disposal leaves such a tree in place with a warning instead of removing through it. The check and the operation are separate calls, so a swap between them is not seen; the comparison with every live Session's writable roots is what keeps the directory out of confined commands' reach.

The Host's file operations refuse what they did not create:

- The repository's index is opened with `O_NOFOLLOW` and `O_NONBLOCK` and copied only when it is a regular file, into a new file created with `O_EXCL` and `O_NOFOLLOW` and mode 0600. A missing index starts an empty snapshot; a link or any other file type fails that turn's record.
- Every directory under the private directory is created exclusively with mode 0700; an existing entry at that name fails the operation.
- A captured copy is created with `O_EXCL` and `O_NOFOLLOW`. The recorder remembers the copies it wrote and reuses only those; an existing copy it did not write fails that capture instead of being treated as already captured.
- A copy is read back with `O_NOFOLLOW`, only as a regular file, and only while its bytes still hash to its name.
- A file a file tool names is checked with `lstat` before it is opened, so a named pipe or device is never opened; the open uses `O_NOFOLLOW` and `O_NONBLOCK` and the open file is checked again before it is read. `O_NOFOLLOW` refuses a link only as the final component; a link among the file's parent directories is followed, as the file tool that names the file follows it.
- A file the sandbox protects from the Session's confined commands, such as one under Delo's home, is never captured.

Windows has no `O_NOFOLLOW` or `O_NONBLOCK`; there the opens keep the exclusive creation and the regular-file checks only.

<a id="git-hardening"></a>
### Git hardening

A model command under `workspace-write` can write the repository's `.git/config` and the files it includes, `.gitattributes`, `.git/info/attributes`, hooks, or a `.git` file that names another git directory. `hardenedGitEnvironment` in `src/hardening.ts` builds the environment of every git command this plugin runs, so none of that state starts a program:

- Every inherited `GIT_*` name and `SSH_ASKPASS` is removed.
- Command-scope configuration, which outranks every configuration file, sets `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `core.pager=cat`, `core.editor` and `sequence.editor` to `false`, empty `diff.external`, `credential.helper`, `core.askPass`, `core.gitProxy`, `core.alternateRefsCommand` and `uploadpack.packObjectsHook`, `core.sshCommand=false`, `protocol.allow=never`, `safe.bareRepository=explicit` and `submodule.recurse=false`. It travels as `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`, which accept any subsection name.
- Before each snapshot, `git config --get-regexp '^(filter|diff)\.'` lists every filter and diff driver in every scope and include, and the snapshot's `add` and `write-tree` run with each filter's `clean`, `smudge` and `process` emptied and `required=false`, and each diff driver's `textconv` and `command` emptied. `diff-tree` also runs with `--no-ext-diff --no-textconv`.
- `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_NO_LAZY_FETCH=1` and `LC_ALL=C` are set.

The person's global and system configuration stay in effect, so their ignore rules and line-ending settings apply as before. A filter they define there, such as Git LFS, is switched off for snapshots too, so a changed LFS file is snapshotted as its content rather than its pointer. The listing and the `add` it guards are two commands; configuration written between them by a command running at the same time is not switched off. Where git runs confined, a program that such configuration starts has no more authority than the Session's own commands. Includes and a `.git` file are followed, because every program they could name is switched off by command-scope configuration.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web deliverables](../../client/ui-deliverables/README.md) — the changed-files card that reads the served summary and opens its files.
- [Subprocess capability](../../subprocess/README.md) — the seam git runs through.
- [historical Turn changed-files card decision](../../../.agents/notes/archived/feature/2026-09-11-turn-changed-files-card.md) — snapshot design, coverage rules, the deferred shadow repository, and rejected alternatives.

<a id="model-experience"></a>
## Model Experience

None, as the recorder appends a log-only `workspace/changes` event that only clients read and registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Summaries, snapshot trees, and captured copies live only as long as their Session in this Host process; earlier turns of a conversation reopened after a Host restart have no card and no comparison. This is the decided behavior: a card whose content the Host can no longer open is not shown.
- Two git features still write into the repository's own git directory during a snapshot: `core.splitIndex` writes `sharedindex.*` files, and git-lfs runs its clean filter on changed files and stores their objects under `.git/lfs`.
- git 2.13 or later is required for `rev-parse --absolute-git-dir`; an unsupported repository format or another git failure abandons the turn with a warning rather than being treated as a plain directory.
- The first snapshot of a Session writes every untracked, non-ignored file of the work tree into the Session's private directory; a repository without a `.gitignore` that carries large build outputs costs that much space in `scratchRoot` until the Session is disposed.
- Edits the user makes during a turn are attributed to that turn.
- A working directory outside any git repository lists file-tool edits only, so shell edits are missing from its card; a shadow repository under the Harness home is deferred until its exclude rules can replace a missing `.gitignore` reliably.
- Outside snapshot coverage only paths a file tool names are captured: a file only a shell command changes there is absent, and a file both changed before its first file-tool call is compared from that call onward.
- Every file-tool edit copies its whole file once per turn, up to `maxFileBytes`, even for paths the snapshots also cover; the copies go with the Session's private directory.
- A comparison serves the listed file's complete text to the client, including ignored files, repository files above the working directory, and files outside the workspace; the summary route serves only paths and counts. A deployment that must keep such content on the Host composes this plugin out.
- A comparison that degrades to whole-file replacement carries every line of both sides, up to twice `maxFileBytes`.
- Windows paths keep native separators in `path`; `display` is always slash-separated.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
