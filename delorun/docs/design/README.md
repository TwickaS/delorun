---
description: "Delorun's design pages: the rules of features that are not built or only partly built, kept apart from the contract pages, which describe only what is built, and how a design becomes a contract."
---

# Designs

English | [中文](README.zh.md)

## Summary

A design page states the rules Delorun has adopted for a feature that is not built, or only partly built: what it does, what it refuses, what it does not protect against, and the denial tests that prove it. The [contract pages](../contracts/README.md) describe only what is built. A design page lets a contributor read the adopted rules of an unbuilt feature without a contract claiming what the code does not do.

Every design page has the same sections: a summary; what exists today, checked against the code; the rules; what the design does not protect against; the denial tests it has; and implementation status. Statements under "What exists today" and "Implementation status" are about the code in this repository. Statements under the rules are the design, and none of them holds until a change builds it.

## How a design becomes a contract

The change that builds a design moves its rules into the contract page that owns them, or into a new contract page, together with the denial tests, and in the same pull request shortens the design page to a pointer to that contract. A partly built design keeps the rules that are not built and names what is built under "Implementation status". A design that states a [security fundamental](../security/fundamentals.md) moves that fundamental's row from `designed` to `enforced` in the same change, with the code and the test that prove it.

A design changes through a pull request like any other document. A change to a design that weakens a security fundamental needs the decision that [the fundamentals page](../security/fundamentals.md#changing-a-fundamental) describes.

## The designs

- [Update and rollback](update-and-rollback.md): the update report's data item, the copy of chat data taken by default, the one rollback table, why a rollback deletes nothing, the refusal of a lower version, and verified updates for the desktop app.
- [The update notice](update-notice.md): the verified check for a newer release that sends nothing about the person, the terminal line and the sidebar notice, the switch that turns it off, the patch rule, and how a plugin targets Delorun's version.
- [Reach on your own tailnet](reach.md): opening the studio from your own devices, device approval only at the home's computer, what a remote session may and may not do, and records and limits for loopback credentials.
- [The first run](first-run.md): one command from install to a first chat, the launcher's progress, a short setup, the start in the terminal and onboarding in the studio.
- [Changes to your harness](changes.md): your harness is the signed release plus the changes you made, each recorded; reviewing, applying and undoing a change, work sessions, the protection setting and what loads without review while it is off, and recovery when a change breaks something.
- [Security extension points](security-extension-points.md): how a plugin can add a check, a warning, a confirmation or a refusal, and why it can never remove or override a built-in check.
- [Repository settings inside a writable workspace](workspace-git-state.md): an open option to keep `.git/config`, hooks and `.git/info` read-only to confined commands, and its cost to a model's own `git config` and `git remote`.
- [Required guards](required-guards.md): a guard Delorun composes and then loses refuses its action instead of letting it run unguarded, and headless runs mount the guards that ask a person so that each refuses there.
- [The journey check](journey-check.md): one end-to-end check in a clean container, from install through update and rollback, and what it does not prove.
- [Native confinement on every command and platform](native-confinement.md): Delorun's protections under every command that boots a Host, the checks that report each confinement rule, the full-access prompt, Docker Desktop's control sockets, Windows, and the instruction consent for writes that commands make.
- [Imported chats and customisation](imported-chats.md): opening imported chats as untrusted until the person trusts them, applying an archive's customisation after a diff, and importing a stock DeepSeek Harness home.
- [The start check and the identity record](start-check.md): a start that compares each runtime file's recorded identity instead of hashing all of it, when the full hash still runs, and what the cheaper check does and does not detect.
- [The studio before the post-boot check](studio-before-check.md): the studio link only once the Host passed its post-boot check, and no studio session or model request before it.
- [The exit code of a failed Host stop](host-stop-exit-code.md): a stop whose Host teardown fails or overruns ends with a failure code and a log line.
- [The release workflow](release-workflow.md): the CI workflow that publishes a signed, logged release, timestamp re-signing, npm publication without a token, two of N rebuilds, Authenticode and the install scripts.
- [Templates](templates.md): saved, content-addressed records of how someone uses the harness; one is active in a profile and holds the person's own edits, and saving, switching, importing, exporting, backing up and restoring each run as one transaction with a restart; and the constraints current work follows so templates stay possible.
