/**
 * What a project folder's top-level names and Git history say about it, for the folder preview: the stacks its marker
 * files name, and its latest commit. The commit comes from one `git log -1` run that applies only the repository's own
 * folder and its non-executing settings: the user's and the system's configuration are off, replacement refs are
 * ignored, a missing object is never fetched and no transport may start, Git looks no higher than the folder, and the
 * settings that could run a program (file system monitor, hooks, signature checks, bare repositories) are overridden. A
 * run has a short time bound and a small output bound, and at most a few run at once on the Host; the run opens no file
 * itself.
 * @module @delorun/plugin-new-workspace/project-facts
 */
import { execFile } from 'node:child_process'
import { devNull } from 'node:os'
import { dirname } from 'node:path'
import { MAX_COMMIT_SUBJECT, STACKS, type LastCommit, type Stack } from './wire.ts'

/** The stack each marker file name belongs to; `.csproj` and `.sln` files are matched by suffix in {@link stacksOf}. */
const MARKERS: Readonly<Record<string, Stack>> = {
  'package.json': 'node',
  'tsconfig.json': 'typescript',
  'deno.json': 'deno',
  'deno.jsonc': 'deno',
  'pyproject.toml': 'python',
  'requirements.txt': 'python',
  'setup.py': 'python',
  'Cargo.toml': 'rust',
  'go.mod': 'go',
  'pom.xml': 'java',
  'build.gradle': 'java',
  'build.gradle.kts': 'java',
  'Gemfile': 'ruby',
  'composer.json': 'php',
  'Package.swift': 'swift',
  'mix.exs': 'elixir',
  'CMakeLists.txt': 'cpp',
}

/**
 * The stacks a folder's top-level names mark.
 * @param names - the names of the folder's top-level entries.
 * @returns each stack once, in the order of {@link STACKS}, so the answer does not depend on the file system's listing order.
 */
export function stacksOf(names: readonly string[]): Stack[] {
  const stacks = new Set<Stack>()
  for (const name of names) {
    const stack = Object.hasOwn(MARKERS, name) ? MARKERS[name] : name.endsWith('.csproj') || name.endsWith('.sln') ? 'dotnet' : undefined
    if (stack !== undefined) stacks.add(stack)
  }
  return STACKS.filter(stack => stacks.has(stack))
}

/** How long `git log` may run, in milliseconds. */
const GIT_LOG_TIMEOUT_MS = 2000

/** The most output `git log` is read for, in bytes: one time, a tab and one subject line. */
const GIT_LOG_MAX_BYTES = 4096

/** Runs `git` with arguments and an environment in a folder; resolves the standard output, or undefined on any failure. */
export type GitReader = (args: readonly string[], env: Readonly<Record<string, string>>) => Promise<string | undefined>

/**
 * Bound how many runs of a reader are in flight across all callers; a run asked for while the limit and the queue are
 * both full is not started.
 * @param read - the reader to bound.
 * @param running - the most runs in flight.
 * @param queued - the most runs waiting for a free place.
 * @returns a reader that answers undefined for a run refused because the queue is full.
 */
export function limitGit(read: GitReader, running: number, queued: number): GitReader {
  let active = 0
  const waiting: (() => void)[] = []
  return async (args, env) => {
    if (active >= running) {
      if (waiting.length >= queued) return undefined
      // The place passes to the waiter directly, so `active` stays at the limit while it is handed on.
      await new Promise<void>((resolve) => { waiting.push(resolve) })
    } else {
      active += 1
    }
    try {
      return await read(args, env)
    } finally {
      const next = waiting.shift()
      if (next === undefined) active -= 1
      else next()
    }
  }
}

/** How many `git log` runs are in flight at once on this Host, and how many wait for a place. */
const GIT_RUNNING = 3
const GIT_QUEUED = 24

/** The reader that runs the installed `git`, bounded across every preview request. */
export const runGit: GitReader = limitGit((args, env) => new Promise((resolve) => {
  execFile('git', [...args], { env, timeout: GIT_LOG_TIMEOUT_MS, maxBuffer: GIT_LOG_MAX_BYTES, windowsHide: true }, (error, stdout) => {
    resolve(error === null ? stdout : undefined)
  })
}), GIT_RUNNING, GIT_QUEUED)

/**
 * The latest commit of a repository.
 * @param folder - a folder whose `.git` is a directory inside it; Git looks no higher than the folder.
 * @param read - runs Git; the installed `git` outside tests.
 * @param environment - the process environment the run takes `PATH` and `HOME` from.
 * @returns the subject and time of `HEAD`, or undefined for a repository with no commit, a missing `git`, a repository
 * Git refuses to read, or output that does not parse.
 */
export async function lastCommitOf(folder: string, read: GitReader = runGit, environment: NodeJS.ProcessEnv = process.env): Promise<LastCommit | undefined> {
  // Nothing outside the repository's own folder applies: no system or user configuration, no replacement refs, no lazy
  // fetch from a remote the repository names (which would start its `core.sshCommand`), no transport, and no search for a
  // repository above the folder. The arguments override the repository's settings that could run a program.
  const env: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'x-delorun-none',
    GIT_CEILING_DIRECTORIES: dirname(folder), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
  }
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot']) {
    const value = environment[name]
    if (value !== undefined) env[name] = value
  }
  const args = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${devNull}`, '-c', 'log.showSignature=false', '-c', 'safe.bareRepository=explicit', '-C', folder, 'log', '-1', '--no-show-signature', '--format=%ct%x09%s']
  const output = await read(args, env)
  const match = /^(\d{1,12})\t([^\r\n]*)/u.exec(output ?? '')
  if (match === null) return undefined
  const subject = (match[2] as string).replace(/[\u0000-\u001f\u007f\p{Cf}]/gu, '').trim().slice(0, MAX_COMMIT_SUBJECT)
  const seconds = Number(match[1])
  return subject === '' ? undefined : { subject, at: new Date(seconds * 1000).toISOString() }
}
