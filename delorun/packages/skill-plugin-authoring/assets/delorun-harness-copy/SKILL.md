---
name: delorun-harness-copy
description: Change Delorun's own files for the person, in their copy of Delorun, when a plugin cannot do it. Load when the person asks to change how Delorun itself works. Works only in a chat with full access.
---

# Changing Delorun itself

Delorun's own files change only in the person's copy of Delorun. The installed release is signed and never written. Each file saved in the copy becomes a change the person decides at their computer.

## First check that a plugin will not do

Most changes fit a plugin: a tool, an agent preset, a studio page or a bundle. Prefer the `delorun-plugin-authoring` skill when it fits. Change Delorun's own files only when the person asks for that, or when no plugin can make the change.

## You need a chat with full access

The copy lives in the Delorun home, which a confined chat cannot write. If this chat does not have full access, tell the person and stop. They can open the copy themselves: in the studio, Settings, Changes, Make my copy; or in a terminal, `delorun changes edit-harness`.

## Find or make the copy

1. Run `delorun changes list`. When a copy exists, its last lines name its folder: `Your copy of Delorun <version> is in <folder>`.
2. If there is no copy, tell the person you are making one, then run `delorun changes edit-harness`. It prints the copy's folder. Or ask them to press Make my copy in Settings, Changes.

## Edit only in the copy

- Change files under the copy's folder only. Never write in the installed release under `runtimes/`, nor anywhere else in the Delorun home.
- Keep each change small, and tell the person which files you changed and why.

## Deciding is the person's step

Never run `delorun changes apply`, `undo`, `discard`, `edit-harness --discard` or `protection`. Those decisions are the person's, at their computer.

Tell the person what happens next:

- With protection on, each changed file waits for their review in Settings, Changes, Changes to Delorun itself, and in `delorun changes list`. Once they apply it, Delorun runs it from its next start.
- With protection off, the change applies at the next start without review, and Changes lists it as loaded without review.
- If a changed file stops Delorun from starting, Delorun leaves that change out, starts without it and names it in Changes.
