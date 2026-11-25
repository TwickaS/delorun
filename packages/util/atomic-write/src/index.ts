/**
 * Zero-dependency atomic file replacement and writer coordination.
 * `writeFileAtomic` writes a random-suffix sibling with exclusive create and
 * the caller's permission bits, then renames it over the target, so readers
 * observe either the old or the new complete content and a replaced file ends
 * up with exactly the stated mode. `withFileLock` serializes cross-process
 * writers of one file through a `wx`-created `<file>.lock` sibling, so a
 * read-modify-write cycle can never resurrect a state another writer just
 * replaced; readers stay lock-free because the rename commit is atomic. A lock
 * whose recorded holder process no longer exists, or whose record stayed incomplete for ten seconds, is taken over;
 * a takeover claim left by a killed claimant is aged out the same way. A lock that the calling asynchronous chain
 * holds is taken again directly, so a change nested inside its own writer never waits for itself.
 * @module @deepseek-ai/dsh-atomic-write
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes } from 'node:crypto'
import { link, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'

const WINDOWS_TRANSIENT_RENAME_ERRORS: ReadonlySet<string> = new Set(['EACCES', 'EBUSY', 'EPERM'])
const WINDOWS_RENAME_RETRY_INITIAL_MS = 20
const WINDOWS_RENAME_RETRY_MAX_MS = 200
const WINDOWS_RENAME_RETRY_LIMIT = 8

/** Whether Windows reported temporary interference with an atomic replacement. */
function isTransientWindowsRenameError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  return WINDOWS_TRANSIENT_RENAME_ERRORS.has((error as NodeJS.ErrnoException | null)?.code ?? '')
}

/** Replace the target after bounded retries for transient Windows interference. */
async function renameAtomicTemp(temp: string, filename: string): Promise<void> {
  let delay = WINDOWS_RENAME_RETRY_INITIAL_MS
  for (let retries = 0;; retries += 1) {
    try {
      await rename(temp, filename)
      return
    } catch (error) {
      if (!isTransientWindowsRenameError(error)) throw error
      if (retries >= WINDOWS_RENAME_RETRY_LIMIT) throw error
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, WINDOWS_RENAME_RETRY_MAX_MS)
  }
}

/**
 * Filesystem options for {@link writeFileAtomic}; `mode` is required so the
 * permission decision stays visible at every call site.
 */
export interface WriteFileAtomicOptions {
  /**
   * Permission bits stamped on the fresh temp inode and carried through the
   * rename (subject to the process umask, like every fresh inode).
   */
  mode: number
  /**
   * Permission bits for parent directories this call creates (subject to the
   * umask; existing directories keep their mode). Omission uses the mkdir
   * default — pass `0o700` when the tree holds user-private data.
   */
  dirMode?: number
}

/**
 * Replace `filename` with `content` in one atomic step, creating parent
 * directories. The content is first written to a random-suffix sibling opened
 * with exclusive create (`wx`): the open refuses to follow a symlink planted
 * at the temp path, and the fresh inode carries `options.mode` through the
 * rename, so replacing a wider-permission file narrows it without a chmod
 * race. The rename also replaces a symlinked target itself instead of writing
 * through to its referent, and the same-directory sibling keeps the rename on
 * one filesystem. Windows replacement retries transient `EACCES`, `EBUSY`,
 * and `EPERM` failures for a bounded interval while the complete temp file
 * remains the rename source. On any remaining failure the temp file is
 * removed and the failure rethrown. Crash durability (fsync) is out of scope.
 * @param filename - final path receiving the content.
 * @param content - complete next file content.
 * @param options - permission bits for the replacement inode.
 */
export async function writeFileAtomic(filename: string, content: string | Uint8Array, options: WriteFileAtomicOptions): Promise<void> {
  await mkdir(dirname(filename), {
    recursive: true,
    ...options.dirMode === undefined ? {} : { mode: options.dirMode },
  })
  // TODO(settings-atomic-durability): Use a replacement that fsyncs the file
  // and parent directory and preserves owner-only permissions on Windows.
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: options.mode, flag: 'wx' })
    await renameAtomicTemp(temp, filename)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Whether an exclusive create found an existing lock. */
async function isLockContention(error: unknown, lockPath: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EEXIST') return true
  if (code !== 'EPERM') return false
  try {
    await lstat(lockPath)
    return true
  } catch {
    // Keep the original EPERM authoritative when lock existence is unproven.
    return false
  }
}

/** Whether the holder a complete `<pid>\n` record names is proven gone: a signal probe finds no such process. */
function holderExited(record: string): boolean {
  const pid = Number(record.trim())
  // PID 0 addresses the caller's process group, and the probe accepts only positive int32 PIDs.
  if (pid === 0 || pid > 0x7fffffff) return false
  // This process is running; a runtime whose probe cannot see itself must not take over its own lock.
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    // EPERM means the process exists under another user.
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/**
 * How long a lock whose record is not a complete `<pid>\n` may stand before its writer is presumed to have died
 * between creating the file and writing the record. A live writer finishes the write within microseconds.
 */
const INCOMPLETE_LOCK_GRACE_MS = 10_000

/**
 * Whether the lock's holder is proven gone: its recorded PID does not exist, or its record stayed incomplete past
 * {@link INCOMPLETE_LOCK_GRACE_MS}, which only a writer killed between create and write leaves.
 */
async function holderGone(lockPath: string, record: string): Promise<boolean> {
  if (/^\d+\n$/.test(record)) return holderExited(record)
  // Only a write cut short leaves nothing, or digits without the newline; any other content is not this protocol's.
  if (!/^\d*$/.test(record)) return false
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > INCOMPLETE_LOCK_GRACE_MS
  /* v8 ignore start -- a lock removed between the read and this stat; no spec can time it. */
  } catch (error) {
    // A lock that vanished proves nothing about a holder.
    void error
    return false
  }
  /* v8 ignore stop */
}

/** The lock file's content, or undefined when it cannot be read. */
async function readLockRecord(lockPath: string): Promise<string | undefined> {
  try {
    return await readFile(lockPath, 'utf8')
  } catch (error) {
    // A lock that vanished, or that Windows is still deleting, proves nothing about a holder.
    void error
    return undefined
  }
}

/**
 * Remove a takeover claim older than {@link INCOMPLETE_LOCK_GRACE_MS}: its claimant was killed between creating it and
 * removing it, and the claim's name repeats for the same lock record, so it would block every later takeover. A
 * live claimant finishes well inside the grace. The claim is renamed to a name only this call knows before it is
 * deleted, so two contenders that both found it stale cannot both delete: one rename moves the file, the other finds
 * nothing. A rename that moved a fresh claim, one created after the age check, links it back; a claimant also
 * re-checks that its claim is still its own before it takes over.
 */
async function removeStaleClaim(claim: string): Promise<void> {
  const aside = `${claim}.stale-${randomBytes(6).toString('hex')}`
  try {
    if (Date.now() - (await stat(claim)).mtimeMs <= INCOMPLETE_LOCK_GRACE_MS) return
    await rename(claim, aside)
    if (Date.now() - (await stat(aside)).mtimeMs <= INCOMPLETE_LOCK_GRACE_MS) await link(aside, claim)
  /* v8 ignore start -- a claim removed or recreated between the failed create and these calls, or a deletion Windows
     refuses; no spec can time either. */
  } catch (error) {
    // A claim that vanished, that another contender now holds, or that Windows refuses to move is not stale to this
    // contender; the next attempt asks again.
    void error
  }
  await rm(aside, { force: true }).catch((error: unknown) => {
    // A moved-aside claim that Windows refuses to delete is a different name from every later claim, so it blocks nothing.
    void error
  })
  /* v8 ignore stop */
}

/**
 * Remove the lock when its recorded holder exited. Contenders that read the
 * same record serialize on a claim file named after it. Under the claim, the
 * claimant re-reads the lock and probes its PID again, and removes it only
 * when it still holds that record and that PID is still gone: the record's
 * holder can no longer release it, and no other contender can remove it
 * without the claim, so a removal never deletes a lock another contender
 * acquired after the dead holder's, including one whose holder reused the PID.
 * @returns Whether this call removed the dead holder's lock.
 */
async function takeOverExitedLock(lockPath: string): Promise<boolean> {
  const record = await readLockRecord(lockPath)
  if (record === undefined || !await holderGone(lockPath, record)) return false
  const claim = `${lockPath}.takeover-${createHash('sha256').update(record).digest('hex').slice(0, 16)}`
  // The token tells this claim from one another contender created at the same name after taking this one over.
  const claimRecord = `${process.pid}\n${randomBytes(8).toString('hex')}\n`
  try {
    await writeFile(claim, claimRecord, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    // Another contender owns the claim for this record, or Windows still deletes the claim it released.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      await removeStaleClaim(claim)
      return false
    }
    if (code === 'EPERM') return false
    throw error
  }
  try {
    if (await readLockRecord(lockPath) !== record || !await holderGone(lockPath, record)) return false
    // Another contender that aged this claim out and created its own is the claimant now; this one steps aside.
    if (await readLockRecord(claim) !== claimRecord) return false
    try {
      await rm(lockPath, { force: true })
    } catch (error) {
      // Windows can refuse the removal while other software briefly holds the file; the next attempt retries.
      void error
      return false
    }
    return true
  } finally {
    if (await readLockRecord(claim) === claimRecord) await rm(claim, { force: true }).catch((error: unknown) => {
      // A claim left behind names a record that is no longer the lock, so it blocks no later takeover.
      void error
    })
  }
}

/**
 * Retry cadence for a contended lock. These stay robustness invariants of the
 * cross-process write protocol rather than deployment tunables: they govern how
 * often a contender asks, which no caller has a reason to vary.
 */
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200

/**
 * The lock files the current asynchronous call chain holds, so an operation that takes a lock its own caller holds
 * runs directly: the lock serializes independent writers, and a caller re-taking its own hold would wait for itself
 * until the deadline expired. The store is per chain, so another task that starts while the lock is held waits.
 */
const heldInChain = new AsyncLocalStorage<ReadonlySet<string>>()

/**
 * How long a contender waits when the caller states no limit — sized for the
 * render-and-rename cycle every call site had when this package was written.
 * Expiry fails the contender rather than guessing whether the existing lock
 * still has an owner. How long is *worth* waiting is a property of the
 * operation the lock holder runs, which is why {@link FileLockOptions.waitMs}
 * exists; the value here is the floor for an operation that does file work
 * alone.
 */
const DEFAULT_LOCK_WAIT_MS = 2_000

/** Options for one {@link withFileLock} acquisition. */
export interface FileLockOptions {
  /** Cancel acquisition and contention waits; the operation owns cancellation after it starts. */
  signal?: AbortSignal
  /**
   * Maximum time to wait for the lock, in milliseconds. State one when the
   * holder's operation legitimately runs longer than file work — a credential
   * mutation that refreshes a token performs a network round trip while
   * holding the lock, and leaving the default in place would fail every other
   * writer of the same file for the duration. Waiting is productive: a
   * contender that acquires the lock afterwards re-reads the committed state.
   */
  waitMs?: number
}

/**
 * Hold the cross-process writer lock for `filename` around one operation. The
 * lock is a `wx`-created sibling (`<filename>.lock`); paired with the
 * rename-based commit of {@link writeFileAtomic}, readers stay lock-free and
 * only writers contend. `EEXIST` is contention directly; an `EPERM` is
 * contention only when a fresh `lstat` confirms the lock path exists, covering
 * Windows exclusive-create behavior. Windows retries one unconfirmed EPERM
 * because the holder can release before the probe; a repeated unconfirmed
 * permission error is rethrown. The lock records its holder's PID. A contender
 * removes the lock and retries at once when no process with that PID exists
 * (`ESRCH`); any other lock, including one whose holder exists under another
 * user (`EPERM`) or whose record is incomplete, is waited for. Contention backs
 * off exponentially and times out after the deadline. A holder whose PID a
 * live process reused keeps its lock until an operator removes it. Takeover
 * proves only that the recorded process exited: an operation that starts other
 * writers must stop them with it or leave its successor a way to find them.
 * The lock is reentrant within the asynchronous call chain that took it: an
 * operation that takes a lock one of its callers holds runs directly, without
 * creating or removing a lock file, and its hold still ends where its caller's
 * does. A task started outside that chain waits like any other writer, so a
 * held lock still refuses them.
 * PIDs are compared on the contender's host, so writers on other hosts or in
 * other PID namespaces sharing the file are unsupported and could both hold
 * the lock. The parent directory must exist.
 * @param filename - the file whose writers this lock serializes.
 * @param operation - the read-render-commit cycle to run while holding the lock.
 * @param options - acquisition options; omitted waits {@link DEFAULT_LOCK_WAIT_MS}.
 * @returns the operation's result; the lock releases on both outcomes.
 */
export async function withFileLock<T>(
  filename: string,
  operation: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const lockPath = `${filename}.lock`
  const held = heldInChain.getStore()
  // The caller already holds this lock: it is one writer, and its own nested change runs under the same hold.
  if (held?.has(lockPath) === true) return await operation()
  const deadline = Date.now() + (options?.waitMs ?? DEFAULT_LOCK_WAIT_MS)
  let delay = LOCK_RETRY_INITIAL_MS
  let retriedUnconfirmedPermissionError = false
  for (;;) {
    options?.signal?.throwIfAborted()
    try {
      await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      if (!await isLockContention(error, lockPath)) {
        // Windows can release the competing lock between exclusive create and lstat.
        if (process.platform !== 'win32'
          || (error as NodeJS.ErrnoException | null)?.code !== 'EPERM'
          || retriedUnconfirmedPermissionError) throw error
        retriedUnconfirmedPermissionError = true
      } else if (await takeOverExitedLock(lockPath)) continue
    }
    if (Date.now() >= deadline) {
      const seen = await readLockRecord(lockPath)
      const own = seen?.trim() === String(process.pid) ? ', this process' : ''
      throw new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath} (record ${JSON.stringify(seen)}${own})`)
    }
    await wait(delay, undefined, { signal: options?.signal })
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    options?.signal?.throwIfAborted()
    const next = new Set([...(held ?? []), lockPath])
    return await heldInChain.run(next, operation)
  } finally {
    await rm(lockPath, { force: true })
  }
}
