---
description: "Design of the studio before the post-boot check: the studio link is issued only once the Host passed C19's post-boot check, and the remaining window in which the studio's port listens before that check."
---

# The studio before the post-boot check

English

## Summary

A Host that `delorun start` boots must pass [C19](../contracts/c19-home-process.md)'s post-boot check before a person works in it: a Host whose guard rows did not start, or whose guard services come from another row, is refused and stopped. Most of this design is built: the studio opens only through a one-time link that the home process issues after the check. What is left is the time between the Web server starting to listen and the check finishing, and the time an interrupted update's health check takes, during which the studio's port accepts connections or the link is issued before the Host is confirmed. This page states the rules that close those windows.

## Contents

- [What exists today](#what-exists-today)
- [The rules](#the-rules)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Denial tests](#denial-tests)
- [What is built so far](#what-is-built-so-far)

## What exists today

- `delorun start` boots the CLI profile with `--no-open` (`bootProfile` in `delo/apps/cli/src/start.ts`), so upstream's browser handoff never runs.
- The studio opens through the home process's `studio.open-token` request (`studioOpenToken` in `delo/packages/home-process/src/studio-link.ts`). The home process answers it from its `host` field, which it sets when `bootedHost()` returns (`delo/packages/home-process/src/home-process.ts`); `bootedHost()` returns only after `assertDeloInvariants` passed. Before that the request is refused with `STUDIO_UNAVAILABLE`.
- `delorun start`, `delorun open` and the end of `delorun setup` call `announceStudio` only after `HomeProcess.start` returned.
- The update channel listens before the Host boots, so a `studio.open-token` request can arrive during boot; it is refused as above.
- The Web server listens inside upstream's `runProfile`, before `assertDeloInvariants` runs. In that window the studio's port accepts connections from a browser that already holds a studio session from an earlier start.
- The update gate (`holdUntilChecked`) holds the CLI profile's agent turns until the home process releases them after the check. Title generation, automatic review and a compaction the person starts are not held.
- After an interrupted update, the home process sets `host` before it runs the update's health check, so a link can be issued while that check runs.

## The rules

1. The home process issues a studio link only in the `running` state: after the post-boot check and, after an interrupted update, after its health check committed the update. In every other state `studio.open-token` is refused with `STUDIO_UNAVAILABLE` and the reason "Delo is still starting".
2. Until the home process releases the update gate, the studio answers every session request, including a reconnect from an earlier session, with a "Delo is starting" response and opens no chat. This needs an upstream admission point on the Web server's connections that a Delo row can hold, the same way the update gate holds turns.
3. The update gate's hold covers every model request the Host makes before the release, not only agent turns.

## What this does not protect against

- **A refused Host's teardown time.** A Host refused by the check runs until its teardown ends; rules 2 and 3 keep a person and the model out of it while it does.
- **Another process of the same user.** A process that runs as the person and holds the home's start token can request a link once Delo runs; the [threat model](../security/threat-model.md) treats the person's own account as trusted.

## Denial tests

- `a studio link requested while the Host boots is refused as still starting`
- `a studio link requested during an interrupted update's health check is refused`
- `a studio reconnect before the post-boot check opens no chat`
- `no title generation request reaches the model before the post-boot check`

## What is built so far

The studio opens only through the one-time link, and the link is issued only after the post-boot check on a normal start. Rules 1 to 3 are not built.
