---
description: "Design of a faster launcher start check: what the per-start hash protects today, an identity record that lets a start compare each runtime file's identity instead of hashing all of it, when the full hash still runs, what the cheaper check does and does not detect, and the measured times."
---

# The start check and the identity record

English

## Summary

Every `delorun` command reads and hashes every file of the installed runtime, about 35,000 files and 770 MB, before it runs anything: about 9 s of every command, against 0.4 s for the same command without the check. This design keeps the full hash where it matters (install, once per runtime in an update, `delorun verify`, a periodic schedule, and whenever the cheaper check cannot vouch for a file) and replaces it at an ordinary start with a comparison of each file's identity (device, inode, size, mode, modification time and change time) against a record the store writes after it last hashed or wrote the file. It is proposed and not built; the rules of the built check are [contract C2](../contracts/c02-release-manifest.md#client-verification).

## Contents

- [What exists today](#what-exists-today)
- [What the per-start hash protects](#what-the-per-start-hash-protects)
- [The rules](#the-rules)
- [What the identity check detects](#what-the-identity-check-detects)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Measurements](#measurements)
- [Denial tests](#denial-tests)
- [What is built so far](#what-is-built-so-far)

## What exists today

- Before every command the launcher runs the runtime store's start check ([C2](../contracts/c02-release-manifest.md#client-verification)): the stored manifest's and file list's signatures with the anchored root, a listing of the installation for missing, extra and irregular entries, then the length and SHA-256 of every file against the signed list. It runs in every verification mode and needs no network.
- An install extracts each archive entry after checking its length and SHA-256 against the signed list, then the store seals the staged tree and reads and hashes every file again before it moves the tree into `runtimes/`.
- An update hashes each runtime several times: the channel opener checks the running runtime, the prepare checks an installed target, and the update report's `running`, `target` and `data` readers each run the store's check on the runtimes they read, at the same time.
- `delorun verify` runs the same full check and reports it as `runtime-files` ([C15](../contracts/c15-verification-checks.md)).

## What the per-start hash protects

The installed files have read-only modes, and confined commands cannot write anywhere under the home on any dialect ([C1](../contracts/c01-home-layout.md#confinement-rules)), so the per-start hash is not what stops a confined command. It stops a runtime whose files changed through something else from starting unnoticed: a person or a tool editing or replacing a file, a partial or mismatched restore or synchronisation, an antivirus quarantine, a failed disk, and a program running with the person's own access that changes runtime files without also changing the launcher. C2 already states the limit: a process with the person's access that also changes the launcher, the stored root or the check itself defeats it.

## The rules

The rules below are proposed.

1. **The record.** `runtimes/delorun-<version>-<platform>.identity.json`, schema `delo.runtime-identity/1`, written by the store through a temporary file and a rename at mode 0444. It holds the version, the platform, the SHA-256 of the signed file list it describes (the digest the verified manifest gives), the installation directory's device and inode, the time of the last full hash, and one entry per file of the list, in the list's order: the identity `<device>:<inode>:<mode>:<size>:<mtime ns>:<ctime ns>`, or `null` when the store could not vouch for it. Retention removes it with its version's other release files.
2. **When the full hash runs.** At install, where each file is hashed once while it is written; once per runtime in an update's prepare, whose report readers share that result; on every `delorun verify`; at a start whose record is missing, unreadable, malformed, owned by another user, or bound to another version, platform, file list or installation directory; at a start whose last full hash is older than the interval or later than the clock; and on every platform or file system where change times cannot be trusted (rule 5).
3. **The start.** The start verifies the stored manifest and file list with the root, lists the installation, and fails on a missing, extra or irregular entry as before. It compares each listed file's `lstat` identity with the record and hashes every file whose identity differs or whose entry is `null`, exactly as the full hash does. A difference in content stops the start with `RUNTIME_CHANGED`; a file whose identity changed and whose content still matches gets its new identity recorded.
4. **Vouching.** The store records an identity only for bytes it hashed or wrote itself: from `fstat` before and after a hash, equal on both sides, or from the extraction's `fstat` after the last write, confirmed by `lstat` before the files move in. Following git's racy-clean rule, an identity whose change time is less than 100 ms before the moment it was observed (2 s when the file system stores whole seconds) is observed again after that window has passed, and recorded only when it is unchanged; a later write then always gets a later change time.
5. **Where change times are trusted.** Linux on ext2, ext3, ext4, XFS, Btrfs, tmpfs, F2FS, ZFS and bcachefs. Everywhere else the start hashes every file, as before: macOS (the kernel ignores a change time set through `setattrlist`, so the rule would hold on APFS and HFS+, but Node cannot name the file system, and a network or FUSE file system reports times its server chooses), Windows (`SetFileInformationByHandle` lets the owner set a file's change time), and Linux on NFS, SMB, FUSE, 9p (WSL's `/mnt/<drive>`), overlayfs and every file system not listed.
6. **The interval.** `DELO_RUNTIME_FULL_CHECK_DAYS`, whole days from 0 to 30, 7 when unset; 0 hashes every file at every start. The launcher refuses any other value with a usage error, before anything runs. It is an environment variable because the launcher reads no settings file yet; it moves into the settings when [C15](../contracts/c15-verification-checks.md#modes)'s `integrity.mode` is read.
7. **No key.** The record carries no signature or MAC. Every process that can write it (one running with the person's own access outside the sandbox, root, or an offline edit of the disk) can also read any key the launcher reads, change the runtime's files and replace the launcher itself; confined commands cannot write under the home on any dialect ([C1](../contracts/c01-home-layout.md#confinement-rules)). A key would therefore stop no one the start check stopped before.

## What the identity check detects

An unprivileged process cannot set a file's change time on Linux: `utimensat` sets the access and modification times and moves the change time to now, and setting the clock needs `CAP_SYS_TIME`. Every write, truncation, `chmod`, `chown`, link or rename onto the path gives the file a new change time or a new inode. So against the record, the identity check detects:

- a file changed in place, by any program, through any path or hard link: its change time moves, and so does its size or modification time in most cases;
- a file replaced by rename, or deleted and created again: a new inode, or the same inode number with a later change time;
- a file restored from a backup that keeps modification times: the restore creates a new inode with a new change time, so the file is hashed; when its bytes match the list it is recorded again, otherwise the start stops;
- a missing, extra, linked or irregular entry, through the listing, as the full hash did;
- a copied, synchronised or reinstalled home: the device or inode differs, so the whole record is unusable and the start hashes every file;
- a clock moved by a privileged process: identities are compared for equality, so a change made after any clock step still gets a change time other than the recorded one unless it lands on the same nanosecond; a clock set back before the last full hash makes the next full hash due at once, and a clock set forward only makes it due early.

## What this does not protect against

- **Content changed without a change time.** Silent corruption of the storage, a write to the block device, an edit of the disk from another system, or a kernel that runs with a moved clock change bytes without the change time a write gives. The full hash every 7 days and `delorun verify` find them; until then a start does not.
- **A forged record.** A process running with the person's own access can change a file and rewrite the record to its new identity. It could equally change the launcher or the stored root and pass the full hash, which the [C2 limit](../contracts/c02-release-manifest.md#what-this-does-not-prove) already states; `delorun verify` and the next full hash still find the changed file.
- **A write in the same clock tick as the observation.** A write landing within one kernel clock tick of the moment the store observed a file's identity during an install or a hash can keep the same change time. Only a process with the person's own access can write the staging directory or the read-only installation, which this threat model already leaves out.

## Measurements

The numbers will come from a timing script under `delo/apps/tools` that builds a signed runtime of the measured size in a throwaway home, installs it through the store and times each operation. The figures before this design come from the wait-time benchmark's first record on 2026-11-10 (WSL2 kernel 6.6, ext4, Node 24, a machine shared with about a dozen other runs; medians of three): `--version` 9.9 s through the launcher against 0.4 s from the runtime's own Node, `status` about 16 s, a later `start` 10 s, building the update report 68.6 s, and unpacking and installing an update 37.7 s.

## Denial tests

| Test | Proves |
| --- | --- |
| `c02-start-stops-on-changed-byte` | A runtime file rewritten in place with one changed byte stops the start, with the identity record present. |
| `c02-start-catches-in-place-change` | A file changed through its own path, keeping its length and modification time, stops the start. |
| `c02-start-catches-renamed-replacement` | A file replaced by renaming another file over it stops the start. |
| `c02-start-record-forgery-out-of-scope` | A record rewritten to a changed file's identity lets the start pass; `delorun verify`'s full hash and the due full hash both stop it. |
| `c02-start-missing-record-hashes-every-file` | A missing, malformed, foreign or rebound record makes the start hash every file, and a changed file then stops it. |
| `c02-start-periodic-full-hash` | A record whose last full hash is older than the interval, or later than the clock, makes the start hash every file. |
| `c02-verify-always-hashes` | The store's full check hashes every file even when every identity matches the record. |

## What is built so far

Nothing of rules 1 to 7 is built. The two changes that do not depend on the record, the install hashing each file once while writing it and an update's readers sharing one check per runtime, are built in the same change as rule 1 or before it.
