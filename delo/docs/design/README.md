---
description: "Delo's design pages: the rules of features that are not built or only partly built, kept apart from the contract pages, which describe only what is built, and how a design becomes a contract."
---

# Designs

English

## Summary

A design page states the rules Delo has adopted for a feature that is not built, or only partly built: what it will do, what it will refuse, what it will not protect against, and the denial tests that will prove it. The [contract pages](../contracts/README.md) describe only what is built. A design page lets a contributor see where Delo is going without a contract claiming what the code does not do.

Every design page has the same sections: a summary; what exists today, checked against the code; the rules; what the design does not protect against; the denial tests it will have; and what is built so far. Statements under "What exists today" and "What is built so far" are about the code in this repository. Statements under the rules are the design, and none of them holds until a change builds it.

## How a design becomes a contract

The change that builds a design moves its rules into the contract page that owns them, or into a new contract page, together with the denial tests, and in the same pull request shortens the design page to a pointer to that contract. A partly built design keeps the rules that are not built and names what is built under "What is built so far". A design that states a [security fundamental](../security/fundamentals.md) moves that fundamental's row from `designed` to `enforced` in the same change, with the code and the test that prove it.

A design changes through a pull request like any other document. A change to a design that weakens a security fundamental needs the decision that [the fundamentals page](../security/fundamentals.md#changing-a-fundamental) describes.

## The designs

- [Update and rollback](update-and-rollback.md): the update report's data item, the copy of chat data taken by default, the one rollback table, and why a rollback deletes nothing.
- [Reach on your own tailnet](reach.md): opening the studio from your own devices, device approval only at the home's computer, and what a remote session may and may not do.
- [The first run](first-run.md): one command from install to a first chat, the launcher's progress, Quick and Full setup, the background start and onboarding in the studio.
- [Changes to your harness](changes.md): your harness is the signed release plus the changes you approved; reviewing, applying and undoing a change, work sessions, the protection setting, and recovery when a change breaks something.
- [Security extension points](security-extension-points.md): how a plugin can add a check, a warning, a confirmation or a refusal, and why it can never remove or override a built-in check.
- [The journey check](journey-check.md): one end-to-end check in a clean container, from install through update and rollback, and what it does not prove.
