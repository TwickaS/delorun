---
description: "Design of the journey check: one end-to-end check in a clean container that installs, sets up, customises, updates, rolls back and refuses a tampered release, and what it does not prove."
---

# The journey check

English

## Summary

The journey check runs a person's whole path through Delo in a clean container: it installs a release, sets it up, customises the profile, updates, rolls back with chat data intact, and refuses a tampered release. Each step asserts what a person would see, and each step is built so that a broken product fails it. It uses keys made for the run and servers inside the check, never a real release key or a live service.

## Contents

- [What exists today](#what-exists-today)
- [The rules](#the-rules)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Denial tests](#denial-tests)
- [What is built so far](#what-is-built-so-far)

## What exists today

No journey check exists. The release, install and launcher packages have their own specs, which run their pieces against local stand-ins, and no check runs them together from a clean machine.

## The rules

### Where it runs

1. The check is `journey`, in the merge tier of [the check runner](../../apps/tools/README.md), with declared inputs, so a tree that changed none of them reuses its recorded pass. It is one spec, run by the existing Docker configuration, alone on the machine.
2. The container is a clean image with Node at the repository's pinned major version and nothing of the repository, and it reaches only the check's own servers.

### Its parts

| Part | What it is |
| --- | --- |
| Keys | A release root, a signing key and a log key generated for the run and thrown away; never a real release key |
| Launcher | Built for the run with the run's root and the run's channel and log addresses as build constants, as the [home layout contract](../contracts/c01-home-layout.md) requires; no setting moves them |
| Release 1 | Built from the tree's commit |
| Release 2 | The same commit under a higher version, with a fixture plugin whose version requirement excludes it, so the update report has an item |
| Release 2b | Release 2 with a Host that never becomes ready, so the health check must fail |
| Release 3 | Built from a scratch commit that applies a fixture patch raising a storage unit's version in upstream's source with its migration, so the persistence schema and real stored data both change; a patch that no longer applies fails the check with that message |
| Channel and log | Two servers in the spec: the releases, and a stand-in log that can agree, contradict or stay silent |
| Model | Upstream's mock model server with a scripted sequence |

### The steps and what each asserts

1. `npx` of the launcher package installs release 1 with the log agreeing, and the home records that the log check ran and passed. `delorun setup` runs with scripted answers, not with a variable that skips it. The studio's page answers, the default profile mounts every row the fork lists, and a scripted chat completes.
2. With the log silent, a fresh install warns, continues and records that the check did not run. With the log contradicting the release, it refuses.
3. The profile is customised: a removed bundle, a disabled row, a plugin taken out of its bundle, a profile patch, a preset, a skill and a theme.
4. `delorun update` to release 2 prints the report naming the fixture plugin before anything changes. After the person confirms, the health check passes and every customisation is present.
5. `delorun recover rollback` returns to release 1 with the customisations and the chat intact, and release 1 reads every Delo record release 2 wrote.
6. An update to release 2b rolls back on its own and names the criterion that failed.
7. An update to release 3 names the data change and takes the copy, and a second chat is written. The rollback restores the first chat, readable under release 1, sets the second aside and says so. Without the restore, release 1 would refuse the migrated storage unit, so a restore that does nothing fails this step.
8. The same update with `--no-data-copy`: the rollback refuses with `ROLLBACK_NEEDS_DATA_COPY`, and `--profile-only` succeeds.
9. A release with one byte changed in an artifact is refused before installation.

## What this does not protect against

The journey check does not cover the npm registry and its attestation, the install script, the root shipped in a real release, the real public release log, the tailnet route, the desktop app, other Node major versions, Windows or macOS. Those keep their own checks or are checked by hand at release.

## Denial tests

The check is itself the denial test of steps 2, 7, 8 and 9: a log contradiction that installs, a rollback that does not restore, a rollback without a copy that does not refuse, and a tampered release that installs each fail it.

## What is built so far

Nothing of this design is built. Steps 4 to 8 also need the [update and rollback design](update-and-rollback.md).
