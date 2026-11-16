# Changelog

English | [中文](README.zh.md)

## Summary

This folder is the one home of Delorun's changelog. It records the whole path from stock DeepSeek Harness (the fork point, upstream release `dsh-v0.2.2-rc.1`) to the Delorun a person is running, in words that a person using Delorun understands.

The changelog is correct during development, not only at a release. Each thing a person can perceive has one fragment file, and a later change to the same thing edits that file. Assembly batches the fragments into small preview sub-versions, so the result reads as a few steps and not as a list of pull requests.

## Contents

- [Folders](#folders)
- [Fragment format](#fragment-format)
- [Edit in place](#edit-in-place)
- [Where a change belongs](#where-a-change-belongs)
- [Sub-versions](#sub-versions)
- [What assembly writes](#what-assembly-writes)
- [Who reads the data file](#who-reads-the-data-file)
- [Commands](#commands)
- [When no fragment is needed](#when-no-fragment-is-needed)

## Folders

| Folder | Holds |
| --- | --- |
| `unreleased/` | The fragments for what exists and works now and is not yet in an assembled version. The next sub-version consumes them. |
| `pending/` | Fragments for something a person cannot reach yet, such as a library no command or shipped profile uses. Each names what must be wired first in a `waits:` line. They are checked like any fragment and never assembled. |
| `releases/<version>/` | The fragments that an assembled version consumed, and `releases/<version>.md`, that version's release notes. |

The wiring work for a feature moves its fragment from `pending/` back to `unreleased/` and deletes the `waits:` line. A fragment that describes something a person cannot do yet does not belong in `unreleased/`: the changelog would promise it.

## Fragment format

Name the file after the thing it describes, in lowercase words separated by hyphens, such as `setup.md`. The file holds front matter with the fields below, then one or more bullet lines for that one feature:

```markdown
---
area: Commands
section: Added
---

- `delorun doctor` checks Docker, the DeepSeek API key's format, the Delorun home's permissions and whether the studio's port is free.
```

| Field | Required | Value |
| --- | --- | --- |
| `area` | yes | One of the areas below. The area is where a person meets the change. |
| `section` | yes | One of the sections below. A fragment has one section; a feature with changes of two sections has two fragments. |
| `replaces` | no | The file name of an earlier fragment, released or unreleased, whose bullets this fragment supersedes in the standing comparison. |
| `waits` | in `pending/` only | What must be wired before a person can reach the feature. |

| `area` | Use it for |
| --- | --- |
| Install and update | Getting Delorun onto a computer and keeping it current |
| Setup | The home, the first run and `delorun setup` |
| Studio | What the studio shows, including its branding |
| Chats and workspaces | Chats, folders, workspaces and what runs in them |
| Safety and privacy | Protections, consent, what stays on the machine |
| Reach | Using a home from other devices |
| Plugins | Loading, configuring and constraining plugins |
| Commands | The `delorun` commands |
| Compatibility | How Delorun relates to DeepSeek Harness versions and to plugins |

| `section` | Use it for |
| --- | --- |
| Added | A new feature or option |
| Changed | Different behaviour of something that existed in DeepSeek Harness |
| Fixed | A bug fixed in DeepSeek Harness behaviour |
| Security | A vulnerability fixed or a protection added |
| Removed | Something taken away, with what replaces it |
| From upstream | A DeepSeek Harness change that Delorun now includes and that people will notice |

The areas print in the order of the first table. Within an area the sections print as Added, Changed, Fixed, Security, Removed, so a feature's description reads before its fixes and protections. A section otherwise only changes how a bullet reads: `Security`, `Removed` and `Fixed` print a bold prefix word, and `Added` and `Changed` print plain bullets.

Write what changes for the person, not how the code changed. Use no internal names, issue or pull-request numbers, work-package names or decision IDs; the gate refuses `#` followed by digits, `WP` followed by a digit, and a `D`, `A` or `C` followed by up to three digits. Each bullet is one physical line. A breaking change also links its upgrade guide under `delorun/docs/upgrade-guide/`. Write about what a person can do with this build; a bullet that describes something no command, profile or screen reaches goes in `pending/`.

## Edit in place

A later change to the same thing edits its fragment; it does not add another. A fix to a feature that no assembled version has shipped is not a `Fixed` bullet, because nobody ever had the bug: the feature's bullet is corrected. When a feature has already been assembled into a version and its behaviour changes, add a new fragment for the change with `replaces: <earlier fragment file name>` when the earlier bullets are no longer true. The earlier version entry keeps its words as the record of that version; the standing comparison drops the superseded bullets.

Fragment file names stay unique across `unreleased/` and `releases/`, so `replaces` names exactly one fragment. Assembly refuses a repeated name and a `replaces` that names no fragment.

## Where a change belongs

Run `node_modules/.bin/tsx delorun/apps/release/src/changelog/assemble.ts --list-unreleased` before writing a fragment. It prints the unreleased fragments by area, which is what the next sub-version would contain, and the pending fragments with what each waits for. If a fragment already describes the thing, edit it. If a pending fragment describes the thing you are wiring, move it to `unreleased/` in the same change.

## Sub-versions

Versions before the first release are preview sub-versions, `0.1.0-preview.N` with N from 1. The lead assembles one when a batch of lanes lands on a build that a person can install, never for a single pull request. The release it leads to is `0.1.0`. Assembling `0.1.0` folds the entries of its previews into one entry as sub-headings, so the released changelog does not read as a long list of previews.

Previews sort before their release (`0.1.0-preview.2` before `0.1.0-preview.10` before `0.1.0`). The date of a version is recorded as the day it was assembled.

## What assembly writes

Assembly reads the fragments in `unreleased/`, the fragments that earlier versions consumed under `releases/`, the data file and the upstream release in `delorun/upstream-patches.json`. It writes:

| File | Content |
| --- | --- |
| `delorun/changelog/changelog.json` | The record: the standing comparison and every assembled version, newest first. |
| `CHANGELOG.md` at the repository root | The same content rendered as Markdown by one pure function, so the two cannot disagree. |
| `delorun/changelog/releases/<version>.md` | The release notes of the version, with the accepted advisories when `--advisories` names a report. |
| `delorun/changelog/releases/<version>/` | The consumed fragments, moved from `unreleased/`. |

`CHANGELOG.md` starts with a standing section, "Delorun compared with DeepSeek Harness `<upstream release>`", regenerated at every assembly. It holds every bullet of every released and assembled fragment that is still true, grouped by area. It is the full path from the fork point. A bullet drops out when a later fragment names its file in `replaces`. Under it, every version is one entry, newest first: the heading with the version and the date, the areas in the fixed order, and a "From upstream" block that names the upstream release the version is based on.

The data file has this shape:

```json
{
  "schema": "delorun.changelog/1",
  "upstream": { "ref": "dsh-v0.2.2-rc.1", "commit": "<sha>" },
  "compared": [{ "area": "Commands", "section": "Added", "text": "..." }],
  "versions": [{
    "version": "0.1.0-preview.1",
    "date": "YYYY-MM-DD",
    "preview": true,
    "headlines": ["You can ..."],
    "areas": [{ "area": "Commands", "items": [{ "section": "Added", "text": "..." }] }],
    "fromUpstream": { "ref": "dsh-v0.2.2-rc.1", "items": [{ "area": "Compatibility", "text": "..." }] },
    "previews": []
  }]
}
```

`previews` holds the previews that a final version folded in, newest first, each with its `version`, `date`, `areas` and `fromUpstream` items; it is empty for a preview and for a version that had none.

`headlines` holds up to three plain sentences, written for people, that say what a person can now do with the version. They come from `--headline <sentence>` (repeat it up to three times) at assembly, open the version's entry and release notes, and feed the "What's new" strip on both sites; a version assembled without any has no field and no strip.

## Who reads the data file

`changelog.json` is meant to be read by the `delorun changelog` command, by the "what is new" part of the update report, by a changelog panel in the studio, and by the documentation site's changelog page. None of these exists in this build; each reads the file when it is built. Until then the file and `CHANGELOG.md` are the whole interface.

## Commands

Run them from the repository root.

| Command | Does |
| --- | --- |
| `node_modules/.bin/tsx delorun/apps/release/src/changelog/assemble.ts --list-unreleased` | Prints the unreleased fragments by area and the pending ones with what each waits for. |
| `node_modules/.bin/tsx delorun/apps/release/src/changelog/assemble.ts --dry-run --version 0.1.0-preview.1` | Prints the entry and the notes the version would write, and writes nothing. |
| `node_modules/.bin/tsx delorun/apps/release/src/changelog/assemble.ts --version 0.1.0-preview.1 [--date YYYY-MM-DD]` | Assembles the version: writes the data file, `CHANGELOG.md` and the notes, and moves the consumed fragments. |
| `node_modules/.bin/tsx delorun/apps/release/src/changelog/check.ts --base <rev>` | The `gates:changelog` gate: every commit after `<rev>` that changes a product file adds a fragment or carries a reasoned trailer, and every fragment in `unreleased/` and `pending/` parses with a valid area. |

`--first-public-release` admits `1.0.0`, which is refused otherwise. `--advisories <report> --manifest <manifest>` adds the accepted advisories of a signed release to its notes. Assembly refuses a version that is already assembled, a preview of a release that is already assembled, a fragment that does not parse, and a run with nothing to assemble.

## When no fragment is needed

A change people cannot perceive ends each of its commits with a trailer that gives the reason:

```text
Changelog: none (tests only)
```

A commit that changes only Markdown files, bilingual pairing records (`*.i18n.yaml`), or files under `delorun/docs/`, `docs/`, `.agents/`, `delorun/apps/tools/`, `delorun/apps/release/`, `.github/` or this folder, needs neither a fragment nor a trailer. The `gates:commits` gate checks the trailer's reason across the range.
