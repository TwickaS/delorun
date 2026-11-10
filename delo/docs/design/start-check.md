---
description: "Why the launcher's start check compares each runtime file's recorded identity instead of hashing all of it: what the per-start hash protects, the decisions behind the identity record, what the comparison does and does not detect, and the times measured before and after."
---

# The start check and the identity record

English

## Summary

Before this change, every `delorun` command read and hashed every file of the installed runtime, about 35,000 files and 770 MB, before it ran anything: about 9 s of every command, against 0.4 s for the same command without the check. Now an ordinary start lists the installation as before and compares each file's identity (inode, mode, size, and modification and change times in nanoseconds, on the installation's device) with a record written after the file was last hashed or written, and hashes only what the record cannot vouch for. The full hash stays at install, once per runtime in an update, on `delorun verify`, every 7 days by default, and wherever the record or the file system cannot vouch. The rules are [contract C2](../contracts/c02-release-manifest.md#client-verification); this page keeps the reasons, the limits and the measurements.

## Contents

- [What the per-start hash protects](#what-the-per-start-hash-protects)
- [Decisions](#decisions)
- [What the identity check detects](#what-the-identity-check-detects)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Measurements](#measurements)
- [Denial tests](#denial-tests)
- [What is built so far](#what-is-built-so-far)

## What the per-start hash protects

The installed files have read-only modes, and confined commands cannot write anywhere under the home on any dialect ([C1](../contracts/c01-home-layout.md#confinement-rules)), so the per-start hash is not what stops a confined command. It stops a runtime whose files changed through something else from starting unnoticed: a person or a tool editing or replacing a file, a partial or mismatched restore or synchronisation, an antivirus quarantine, a failed disk, and a program running with the person's own access that changes runtime files without also changing the launcher. C2 already states the limit: a process with the person's access that also changes the launcher, the stored root or the check itself defeats it.

## Decisions

- **Identity, not hash, at an ordinary start.** No unprivileged process can set a change time back on the trusted file systems, so an unchanged identity means an unwritten file for every actor the start check stopped before. The listing for missing, extra and irregular entries stays at every start.
- **No device number across runs.** WSL2 and device-mapper renumber devices at a reboot, which would make every record unusable after one. Each file's device must instead equal the installation directory's current device, and the record binds the directory's inode.
- **Racy entries.** As in git's racy-clean rule, an identity whose change time lies within 2 s of the record's capture time vouches for nothing and is hashed until a later capture leaves it behind: a write in the same clock step, or the same second on a file system that stores whole seconds, can keep a change time. An install waits until the newest file it wrote is 2 s old before it captures, so the first start after it hashes nothing.
- **Capture only from a hash or a write.** A hash takes `fstat` of its own descriptor before and after reading and records the identity only when both are equal and on the installation's device; an install records the extraction's `fstat` after the last write, confirmed by `lstat` before the tree moves in. The record is written atomically under `store.lock`; a start or a full check does not wait for the lock and leaves the record as it is while an install, a switch or a removal holds it. A full check on request writes only when it has something new to record, so `delorun verify` and the launcher's check of `previous` before it refuses a command leave an intact home as it was.
- **Outside every read exemption.** The record lives under `trust/runtime-files/` at mode 0600, not under `runtimes/`, which confined commands may read. Its binding (schema, version, platform, the SHA-256 of the file list and of the manifest, the directory's inode, the file system's type and the capture time) makes a record of another release, installation or file system unusable, and anything unusable means the full hash, never a pass.
- **No key.** Every process that can write the record (one running with the person's own access outside the sandbox, root, or an offline edit of the disk) can also read any key under the same home, change the runtime's files and replace the launcher. A signature or MAC would stop no one the start check stopped before.
- **Trusted file systems.** Linux on ext2 to ext4, XFS, Btrfs, F2FS, tmpfs and overlayfs, read with `statfs` on the installation and re-checked at each start. Everything else hashes every file at every start: NFS, SMB, FUSE, virtiofs, 9p and WSL's drvfs report times another party chooses; Windows lets a file's owner set its change time (NTFS `ChangeTime`); and macOS waits for a test on APFS that proves an unprivileged process cannot set a change time back there (the kernel ignores `ATTR_CMN_CHGTIME` in `setattrlist`, but no test runs on macOS here).
- **The interval.** `DELO_RUNTIME_FULL_CHECK_DAYS`, whole days from 0 to 30, 7 when unset; 0 hashes every file at every start, and any other value stops the launcher with its usage text. It is an environment variable because the launcher reads no settings file; it belongs with [C15](../contracts/c15-verification-checks.md#modes)'s `integrity.mode` once a setting is read there.
- **One check per runtime in an update.** An update's prepare runs inside the store's `shareChecks`: the channel opener's check of the running runtime, the target's install or intact check and the update report's `running`, `target` and `data` readers share one file check per runtime.

## What the identity check detects

An unprivileged process cannot set a file's change time on Linux: `utimensat` sets the access and modification times and moves the change time to now, and setting the clock needs `CAP_SYS_TIME`. Every write, truncation, `chmod`, `chown`, link or rename onto the path gives the file a new change time or a new inode. So against the record, the identity check detects:

- a file changed in place, by any program, through any path or hard link, with its size, mode and modification time restored or not: its change time moves;
- a file replaced by rename, or deleted and created again, with the same size, mode and times: a new inode, or the same inode number with a later change time;
- a file restored from a backup that keeps modification times: the restore gives it a new inode and change time, so it is hashed; when its bytes match the list it is recorded again, otherwise the start stops;
- a missing, extra, linked or irregular entry, through the listing, as the full hash did;
- a copied, synchronised or reinstalled home: the installation's inode differs, so the record is unusable and the start hashes every file;
- a clock moved by a privileged process: identities are compared for equality, so a change made after any clock step still gets a change time other than the recorded one unless it lands on the same nanosecond; a clock set back before the last full pass makes the next one due at once, and a clock set forward only makes it due early.

## What this does not protect against

- **Content changed without a change time.** Silent corruption of the storage, a write to the block device, or an edit of the disk from another system changes bytes without the change time a write gives. The next full pass, at most the configured interval later, and `delorun verify` find it; until then a start does not. This is the one real loss against the hash at every start, and it is a reliability gap, not a gain for an attacker, who needs root or the person's own access to make such a change.
- **A write in the same clock step as an install's own write.** An install records the identity of each file right after writing it from bytes that matched the list. A write to that file within the same step of the kernel's clock (a few milliseconds), followed by a `chmod` back to the installed mode, can leave the identity unchanged, and the install then records bytes it did not write. Only a process with the person's own access can write the 0700 staging directory, which this threat model already leaves out; the next full pass finds the change.
- **A forged record.** A process running with the person's own access can change a file and rewrite the record to its new identity. It could equally change the launcher or the stored root and pass the full hash, which the [C2 limit](../contracts/c02-release-manifest.md#what-this-does-not-prove) already states; `delorun verify` and the next full pass still find the changed file.

## Measurements

`node_modules/.bin/tsx delo/packages/runtime-store/tests/timing/start-check-timing.ts` builds a signed synthetic runtime of a real runtime's size (35,287 files, 769 MiB) in a throwaway home and times the store's own operations; the "before" rows run the same code with every file hashed, as the store did before this change. Record of 2026-11-10 at 20:22 UTC: 22 CPUs (Intel Core Ultra 9 185H), WSL2 kernel 6.6, ext4, Node 24.22.0, a machine shared with other runs (load average 11 to 21, I/O pressure 1.2% to 1.8%), warm page cache; start checks are medians of three, the rest single samples.

| Operation | Before | After |
| --- | --- | --- |
| Start check, in the measuring process | 9.1 s | 0.60 s |
| Start check, in a fresh process with module loading through `tsx` | 9.8 s | 0.92 s |
| First start after a launcher-style install | 9.1 s | 0.45 s |
| An install's store work beyond the fill's own writes | 12.0 s | 3.3 s (up to 2 s of it the wait that settles the record) |
| An update's prepare beyond the fill's writes: the opener's check, the install and the report readers' four checks | 83.6 s | 16.5 s |

The wait-time benchmark's first record, on the same machine on the same day, measured each command through the launcher before this change: `--version` 9.9 s (0.4 s from the runtime's own Node, 0.1 s for the launcher alone), `status` about 16 s, a later `start` 10.0 s, `stop` 8.8 s, and building the update report 68.6 s within an update. The start check is the only part of those commands this change touches, so each now takes about 9 s less; `--version` comes to roughly 0.4 s plus the launcher and a start check of 0.6 to 0.9 s. The commands were not timed end to end on a real closure, because the trunk's release recipe cannot build one yet.

Of the remaining 0.6 s, about half is the signature check of the 5 MB file list, which every start keeps: `@delo/release`'s strict JSON parser and its canonical re-serialisation of the list for the signature. The other half is the listing and `lstat` of 35,287 files.

## Denial tests

The specs are `delo/packages/runtime-store/tests/identity.integration.spec.ts`, beside C2's existing rows.

| Test | Proves |
| --- | --- |
| `c02-start-stops-on-changed-byte` | A runtime file rewritten with one changed byte stops the start, with the record present. |
| `c02-start-catches-in-place-change` | A changed byte with the file's size, mode and modification time restored by `utimes` stops the start, and the failed start leaves the record as it was. |
| `c02-start-catches-renamed-replacement` | A file renamed over the original with the same size, mode and modification time stops the start. |
| extra, missing, symbolic link, `chmod` | An extra, a missing and a linked entry stop the start; a changed mode forces a re-hash, which passes and records the new identity. |
| racy entry | An entry whose change time is within 2 s of the capture time is hashed, and the change it hides stops the start. |
| `c02-start-missing-record-hashes-every-file` | A missing, truncated, unparsable, laxer, linked, oversized, foreign or rebound record, and one of another schema, version, platform, file list, manifest, root inode, file system or length, each make the start hash every file. |
| `c02-start-record-forgery-out-of-scope` | A record rewritten to a changed file's identity lets the start pass: the documented limit. |
| `c02-verify-always-hashes` | The full check behind `delorun verify` and the update hashes every file even when every identity matches. |
| `c02-start-periodic-full-hash` | A last full pass older than the interval or later than the clock, or an interval of 0, makes the start hash every file. |
| untrusted file systems | NFS, a file system `statfs` cannot name and macOS make the start hash every file; an install there writes no record. |
| change times cannot be set back | On each trusted file system the test machine has, a write followed by `utimes` to the old times leaves a later change time; the test fails if it does not. |
| the lock | A start that re-hashed leaves the record alone while another operation holds `store.lock`. |

No confined command can write the record on any dialect: it lies under the home, which C1's `home-write-denied` covers for every file, and outside the read exemptions, which C1's `home-read-denied` covers where the dialect enforces reads.

## What is built so far

Everything on this page is built for the CLI launcher, `delorun verify` and an update's prepare. Not built: the H1 health check of an update's target and the check before a successor starts still run the full hash and could run the start check instead; macOS keeps the full hash until a test on APFS runs; the interval is an environment variable until the launcher reads a setting.
