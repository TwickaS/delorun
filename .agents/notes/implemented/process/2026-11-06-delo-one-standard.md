# Agent Note: One agent guide, documentation standard, skills folder and notes tree

Status: implemented

English | [中文](2026-11-06-delo-one-standard.zh.md)

## Problem

Delo and upstream need the same agent instructions and documentation rules, because the same agents read both. A separate Delo guide would state the shared rules a second time, and the two statements would drift apart. A layered guide, in which Delo's file overrides upstream's, would hide a rule from any reader who opens only the file that states it.

## Decision

The repository has one root agent guide, `AGENTS.md`, with `CLAUDE.md` as its symlink. It has one documentation standard, `docs/AGENTS.md`, one skills folder, `.agents/skills/`, and one notes tree, `.agents/notes/`. Delo edits each of these files in place from upstream's version. Each rule has one home, and Delo's rules sit beside upstream's rules in the same file.

Delo's documentation lives under `delo/docs/` in upstream's tiers, and Delo's decisions are Agent Notes in `.agents/notes/` beside upstream's. Delo's own skills are the `.agents/skills/delo-*/` folders. Upstream's changes to these files are merged by hand, as for any upstream file that Delo changes, and generated files are regenerated rather than merged.

## Verification

The documentation budget manifest, `scripts/doc-budgets.manifest.json`, sets ceilings for the root guide and the documentation standard, so `pnpm run verify-doc-budgets` fails when either file exceeds its ceiling. The notes gates, `pnpm run verify-agent-note-format` and `pnpm run verify-translation-pairing`, check Delo's notes in the same tree as upstream's notes.

## Related

The archived [doc tiers and budgets decision](../../archived/process/2026-07-04-doc-tiers-and-budgets.md) records the history of the documentation tiers and budgets. It is frozen and does not state current rules.

## Alternatives considered

**A separate Delo guide.** A `delo/AGENTS.md` would give agents two guides with no rule for which one governs a conflict, and every shared rule would appear in both files.

**A layered guide.** Delo's file on top of upstream's file requires a reader to load both to know a rule, and an override that the upper file does not restate is easy to miss.

## Consequences

An agent reading the repository sees one set of rules. Delo's additions are identifiable by their subject, such as the `delo/` paths they name.

Upstream's changes to these files are merged by hand, which adds review work to each upstream release.

The documentation budgets limit how much text the shared files can carry, so a new rule replaces or shortens existing text when a file reaches its ceiling.
