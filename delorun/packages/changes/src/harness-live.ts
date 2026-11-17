/**
 * When a decided change to Delorun itself takes effect (contract C21, "Harness edits"): live, without a restart, or at
 * the next start. A running Delorun runs from one composed tree, or the signed installation, whose files never change;
 * applying or undoing a change composes another tree. Server code is never live: a module loaded from another tree
 * would load a second copy of every package it imports. Only the studio's built client assets are live
 * ({@link isLiveHarnessFile}): the Host reads each one from disk on every request, so the studio's Changes plugin
 * serves the composed content of such a file in place of the running tree's, and a page reload shows it.
 *
 * The composition a Host booted with is known when the composed tree it runs is named by the digest of what the
 * records compose at its boot, or when it runs the signed installation; otherwise it is unknown, and every decided
 * change counts as one that waits for a restart.
 *
 * @module @delorun/changes/harness-live
 */
import { basename } from 'node:path'
import { composition } from './harness-tree.ts'
import { readSignedFile, type SignedRuntime } from './harness.ts'
import { readObject, readVersion } from './store.ts'
import type { ContentVersion } from './types.ts'

/** Where, relative to the runtime, the studio's built client assets live: Vite's hashed output under `dist/assets/`. */
export const LIVE_HARNESS_PREFIX = 'app/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/'

/** The studio's URL path of the assets under {@link LIVE_HARNESS_PREFIX}. */
export const LIVE_ASSET_ROUTE = '/assets/'

/** A name the studio's asset route matches as it is written: no character a URL would encode, no `.` or `..` segment. */
const LIVE_NAME = /^(?!\.{1,2}(?:\/|$))[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/u

/**
 * Whether a change to this file can take effect without a restart.
 * @param file - the file, relative to the runtime, `/`-separated.
 * @returns true for one of the studio's built client assets whose URL path is the file's name as written.
 */
export function isLiveHarnessFile(file: string): boolean {
  return file.startsWith(LIVE_HARNESS_PREFIX) && LIVE_NAME.test(file.slice(LIVE_HARNESS_PREFIX.length))
}

/**
 * @param file - a file for which {@link isLiveHarnessFile} holds.
 * @returns the studio's URL path that serves it, such as `/assets/index-1a2b.css`.
 */
export function liveAssetPath(file: string): string {
  return `${LIVE_ASSET_ROUTE}${file.slice(LIVE_HARNESS_PREFIX.length)}`
}

/** The files, other than the signed ones, a Host booted with. */
export type RunningComposition =
  | { readonly kind: 'known', readonly files: Readonly<Record<string, ContentVersion>> }
  | { readonly kind: 'unknown' }

/**
 * The composition a Host that boots now runs.
 * @param home - the Delorun home.
 * @param runtime - the runtime version it runs.
 * @param composedRoot - the composed tree it runs from, or undefined when it runs the signed installation.
 * @returns the composed files, or unknown when the records now compose another tree than the one it runs.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the harness's record or log is not one Delorun wrote.
 */
export async function runningComposition(home: string, runtime: string, composedRoot: string | undefined): Promise<RunningComposition> {
  if (composedRoot === undefined) return { kind: 'known', files: {} }
  const now = await composition(home, runtime)
  return now !== undefined && now.digest === basename(composedRoot) ? { kind: 'known', files: now.files } : { kind: 'unknown' }
}

/** How what the records compose now differs from what a Host runs. */
export interface HarnessDrift {
  /** Files that differ and take effect only at the next start, sorted; every composed file when the Host's composition is unknown. */
  readonly restart: readonly string[]
  /** Files that differ and are live, sorted, with what the records compose for each: an approved version, or the signed file. */
  readonly live: ReadonlyMap<string, ContentVersion | 'signed'>
  /** Whether the Host's composition is unknown, so a restart is needed whatever the files say. */
  readonly unknown: boolean
}

/**
 * Compare what the records compose now with what a Host runs.
 * @param home - the Delorun home.
 * @param runtime - the runtime version.
 * @param running - what the Host booted with.
 * @returns the files that differ, live or not.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the harness's record or log is not one Delorun wrote.
 */
export async function harnessDrift(home: string, runtime: string, running: RunningComposition): Promise<HarnessDrift> {
  const now = (await composition(home, runtime))?.files ?? {}
  if (running.kind === 'unknown') return { restart: Object.keys(now).sort(), live: new Map(), unknown: true }
  const restart: string[] = []
  const live = new Map<string, ContentVersion | 'signed'>()
  for (const file of new Set([...Object.keys(now), ...Object.keys(running.files)])) {
    const composed = now[file]
    if (composed === running.files[file]) continue
    if (isLiveHarnessFile(file)) live.set(file, composed ?? 'signed')
    else restart.push(file)
  }
  return { restart: restart.sort(), live: new Map([...live].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), unknown: false }
}

/**
 * The bytes a live file's composed content holds, read from the store or the signed installation and checked.
 * @param home - the Delorun home.
 * @param signed - the running runtime's signed installation.
 * @param file - the file.
 * @param content - an approved version, or `signed`.
 * @returns the bytes, or undefined when the composed content holds no such file.
 * @throws {ChangesError} `STORE_CORRUPT` when the store's version or object is not what Delorun wrote;
 *   `RUNTIME_CHANGED` when the installation's file differs from the signed release's.
 */
export async function liveFileBytes(home: string, signed: SignedRuntime, file: string, content: ContentVersion | 'signed'): Promise<Buffer | undefined> {
  if (content === 'signed') {
    const listed = signed.files.find(entry => entry.path === file)
    return listed === undefined ? undefined : readSignedFile(signed, listed)
  }
  const { entries } = await readVersion(home, content)
  const [entry] = entries
  return entry?.type === 'file' && entry.path === file ? readObject(home, entry.digest) : undefined
}

/** A restart as the studio reads it. */
export type HarnessRestartView =
  | { readonly kind: 'idle' }
  | { readonly kind: 'restarting', readonly since: string, readonly phase: 'waiting' | 'starting', readonly runningChats: number }
  | {
    readonly kind: 'failed'
    readonly at: string
    readonly failure: string
    readonly reason: 'health' | 'chats' | 'host'
    readonly leftOut?: { readonly id: string, readonly file: string }
  }

/**
 * The home process's restart as it gives it to the Host (the `changesRestart` service), with the composition that
 * Host booted with, so the studio's Changes routes say what a restart would bring and begin one.
 */
export interface ChangesRestartHost {
  /** What the Host booted with. */
  readonly running: RunningComposition
  /**
   * @returns the restart now, or the last one's failure.
   */
  view(): HarnessRestartView
  /**
   * @returns the running chats a restart would wait for now.
   */
  runningChats(): number
  /**
   * Begin a restart, which runs on after this returns.
   * @param request - whether running chats are cancelled, and the longest wait for them in seconds.
   * @returns the chats it waits for.
   * @throws an error whose `code` is `RESTART_IN_PROGRESS`, `UPDATE_IN_PROGRESS` or `NO_RUNTIME_STORE`, before anything changed.
   */
  begin(request: { readonly stopChats: boolean, readonly drainTimeoutS: number }): Promise<{ readonly runningChats: number }>
  /**
   * End a restart that still waits for running chats.
   * @returns whether one was waiting.
   */
  cancel(): Promise<boolean>
  /** Forget the last restart's failure. */
  clearFailure(): void
}
