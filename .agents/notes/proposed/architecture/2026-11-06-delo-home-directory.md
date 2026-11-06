# Agent Note: Delo keeps its state in ~/.delo beside an untouched ~/.dsh

Status: proposed

English | [中文](2026-11-06-delo-home-directory.zh.md)

## Problem

Stock DSH keeps all user data under one home root, `$DSH_HOME` or `~/.dsh`. Delo installs on the same machine as stock DSH, and both read and write their state. If Delo used `~/.dsh`, the two would read and write one set of plugins, settings and chats, so an update in one could break the other, and stock DSH could not be trusted to keep working beside Delo.

## Proposal

Delo's state would live in `~/.delo`, and Delo would never modify `~/.dsh`. Setup would offer to import a copy of a stock `~/.dsh` on request. The person would choose whether to import, and the import would read `~/.dsh` without writing to it. Stock DSH would keep working beside Delo.

Upstream's home precedence would be unchanged: an explicit configured path, then `$DSH_HOME`, then `~/.dsh`. Delo's launcher would supply `~/.delo` as the home root for Delo's processes, and the resolver would apply its usual rules to that root. Delo's export files would carry workspaces and chats between the two homes.

## Related

The [single harness home resolver decision](../../implemented/architecture/2026-07-24-single-harness-home-resolver.md) makes `$DSH_HOME` or `~/.dsh` the one home root for the harness. This proposal would depart from it for Delo, whose default home root would be `~/.delo`. The single-root rule and the resolver's precedence would stay as that decision states them, and the upstream decision would stay in force for stock DSH.

The [shared agents root decision](../../implemented/architecture/2026-10-05-shared-agents-root-instructions.md) keeps the shared agents root outside the harness home. This proposal does not name that root.

## Alternatives considered

**Sharing `~/.dsh`.** Both harnesses would read and write one set of plugins, settings and chats, so an update in one could break the other, and stock DSH could not be left as it was.

**Migrating `~/.dsh` in place.** Moving the stock data out of its home would break stock DSH, and a person who returned to DSH would find its data gone. A copy on request leaves both homes usable.

## Acceptance criteria

- A denial test runs setup, an import and a Delo session against a fixture stock home, and the fixture is byte-identical afterwards.
- Stock DSH, started against the same fixture after the Delo session, finds the same data it found before.
- The resolver's tests in `packages/util/home-paths/tests/home-paths.spec.ts` pass with the precedence cases unchanged.
- An export file from one home imports into the other with its workspaces and chats.

## Risks

Two homes hold two copies of plugins, settings and chats, and the person has to choose which copy is authoritative for each workspace.

The import is one-way, so a change made in one home after the import does not reach the other.

Tools and scripts that assume `~/.dsh` need the Delo home path. That is a deliberate change of default, and those tools and scripts must follow it.
