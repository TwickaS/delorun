# Agent Note: Delo keeps its state in ~/.delo beside an untouched ~/.dsh

Status: implemented

English | [中文](2026-11-06-delo-home-directory.zh.md)

## Problem

Stock DSH keeps all user data under one home root, `$DSH_HOME` or `~/.dsh`. Delo installs on the same machine as stock DSH, and both read and write their state. If Delo used `~/.dsh`, the two would read and write one set of plugins, settings and chats, so an update in one could break the other, and stock DSH could not be trusted to keep working beside Delo.

## Decision

Delo's state lives in `~/.delo`, and Delo never modifies `~/.dsh`. Setup offers to import a copy of a stock `~/.dsh` on request. The person chooses whether to import, and the import reads `~/.dsh` without writing to it. Stock DSH keeps working beside Delo.

Upstream's home precedence is unchanged: an explicit configured path, then `$DSH_HOME`, then `~/.dsh`. Delo's launcher supplies `~/.delo` as the home root for Delo's processes, and the resolver applies its usual rules to that root, so each process has one home root. Delo's export files carry workspaces and chats between the two homes.

## Verification

A denial test runs setup, an import and a Delo session against a fixture stock home, and then asserts that the fixture is byte-identical to its state before the run. The resolver's own tests in `packages/util/home-paths/tests/home-paths.spec.ts` cover the precedence that this decision keeps.

## Related

The [single harness home resolver decision](../architecture/2026-07-24-single-harness-home-resolver.md) makes `$DSH_HOME` or `~/.dsh` the one home root for the harness. This decision departs from it for Delo, whose default home root is `~/.delo`. The single-root rule and the resolver's precedence stay as that decision states them, and the upstream decision stays in force for stock DSH.

The [shared agents root decision](../architecture/2026-10-05-shared-agents-root-instructions.md) keeps the shared agents root outside the harness home. This decision does not name that root.

## Alternatives considered

**Sharing `~/.dsh`.** Both harnesses would read and write one set of plugins, settings and chats, so an update in one could break the other, and stock DSH could not be left as it was.

**Migrating `~/.dsh` in place.** Moving the stock data out of its home would break stock DSH, and a person who returned to DSH would find its data gone. A copy on request leaves both homes usable.

## Consequences

A machine with both harnesses has two homes, and the person chooses which home holds each copy of a workspace or chat.

The import is a one-way copy. Changes made in Delo after the import do not reach `~/.dsh`, and changes made in `~/.dsh` after the import do not reach Delo.

Upstream's resolver note remains the owner of the stock home defaults, which keeps the two decisions separate.
