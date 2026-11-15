---
description: "Design option, open for decision: keep a repository's `.git/config`, `.git/hooks` and `.git/info` read-only to confined commands inside a writable workspace, so a model cannot plant configuration that the person's own git or editors later run with full access; with its cost to legitimate model use of `git config` and `git remote`."
---

# Repository settings inside a writable workspace

English

## Summary

Under `workspace-write` a confined command can write a repository's `.git/config`, the files it includes, `.git/hooks` and `.git/info/attributes`. The harness's own git commands run hardened and inside the Session's sandbox, so such settings start no program with the harness's authority. The person's own git, editors and other tools that read the repository outside the sandbox are not hardened: a setting a confined command wrote there can start a program with the person's full access the next time they run git in that repository. This page states one direction for closing that, for a later decision. It is not adopted.

## Contents

- [What exists today](#what-exists-today)
- [The rules](#the-rules)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Denial tests](#denial-tests)
- [Implementation status](#implementation-status)

## What exists today

The sandbox binds the whole workspace writable under `workspace-write`, `.git` included, on every dialect. The harness's change summary runs git with configuration that switches off the file-system monitor, hooks, filters and diff drivers, inside the Session's sandbox ([workspace-changes](../../../packages/deliverables/workspace-changes/README.md#git-hardening)). Nothing protects the person's own tools from settings a confined command wrote.

## The rules

1. Under `workspace-write`, the sandbox keeps `.git/config`, every file `.git/config` includes from inside the workspace, `.git/hooks` and `.git/info` read-only to confined commands, for each repository whose `.git` directory lies in a writable root at wrap time. bwrap binds them read-only over the writable bind; Landlock and Seatbelt leave them out of the write grants.
2. A `.git` file that names a git directory inside a writable root is treated as that directory.
3. The rest of `.git` stays writable, so a confined command can still commit, branch, fetch into existing remotes and rebase.
4. A model that needs `git config` or `git remote add` asks for an escalation, whose approval names the repository and the setting.

The cost: a model can no longer set a repository's user name, add a remote, install a hook the person asked for, or run tools that write `.git/config` themselves (some submodule and LFS commands do), without an escalation each time. A repository created inside the workspace during a command gets the rule only from the next wrap.

## What this does not protect against

- A setting written while the Session ran under `danger-full-access`, or through an approved escalation.
- Settings outside `.git`: `.gitattributes` in the work tree, `.envrc`, editor and task-runner configuration in the workspace, which the person's own tools may also run.
- A repository whose `.git` directory lies outside every writable root but whose work tree is inside one.

## Denial tests

- `git-config-readonly`: on each dialect, a confined command under `workspace-write` cannot change `.git/config`, a file it includes from the workspace, `.git/hooks/*` or `.git/info/attributes`, and can still create a commit.
- `gitfile-readonly`: the same holds for a git directory named by a `.git` file.

## Implementation status

Nothing. The threat model states the limit ([threat model](../security/threat-model.md#confinement-of-native-commands)).
