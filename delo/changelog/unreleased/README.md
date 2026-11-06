# Unreleased changes

English | [中文](README.zh.md)

Each change people can perceive adds one fragment file to this folder, written in words that a person using Delo understands. A release assembles the fragments into `CHANGELOG.md` and its release notes, adds the "From upstream" section and moves the consumed files into `releases/<version>/`. The `gates:changelog` gate refuses a commit that changes product files unless that commit adds a fragment or carries a `Changelog: none (<reason>)` trailer. The `gates:commits` gate checks the trailer's reason across the range.

## Format

Name the file after the change, in lowercase words separated by hyphens, such as `upstream-changed-lane.md`. The file holds front matter with one `section:` field, then one or more bullet lines:

```markdown
---
section: Fixed
---

- The recorded-session replay no longer fails every scenario when the build is missing; the checks build first.
```

| `section` | Use it for |
| --- | --- |
| Added | A new feature or option |
| Changed | Different behaviour of something that existed |
| Fixed | A bug fixed |
| Security | A vulnerability fixed or a protection added |
| Removed | Something taken away, with what replaces it |
| From upstream | A DeepSeek Harness change that Delo now includes and that people will notice |

The release notes print the sections in this order: Security, Added, Changed, Fixed, Removed, From upstream.

Write what changes for the person, not how the code changed. Use no internal names, issue or pull-request numbers, work-package names or decision IDs; the gate refuses `#` followed by digits, `WP` followed by a digit, and a `D`, `A` or `C` followed by up to three digits. A breaking change also links its upgrade guide under `delo/docs/upgrade-guide/`.

## When no fragment is needed

A change people cannot perceive ends each of its commits with a trailer that gives the reason:

```text
Changelog: none (tests only)
```

A commit that changes only Markdown files, or files under `delo/docs/`, `docs/`, `.agents/`, `delo/apps/tools/`, `delo/apps/release/`, `.github/` or this folder, needs neither a fragment nor a trailer.
