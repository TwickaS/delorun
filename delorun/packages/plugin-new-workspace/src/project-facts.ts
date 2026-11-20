/**
 * What a project folder's top-level names and Git history say about it, for the folder preview: the stacks its marker
 * files name, and its latest commit. The commit comes from one `git log -1` run with the repository's own
 * configuration neutralised (no file system monitor, no hooks, no signature checks), a short time bound and a small
 * output bound; it opens no file itself.
 * @module @delorun/plugin-new-workspace/project-facts
 */
import { execFile } from 'node:child_process'
import { devNull } from 'node:os'
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

/** The reader that runs the installed `git`. */
export const runGit: GitReader = (args, env) => new Promise((resolve) => {
  execFile('git', [...args], { env, timeout: GIT_LOG_TIMEOUT_MS, maxBuffer: GIT_LOG_MAX_BYTES, windowsHide: true }, (error, stdout) => {
    resolve(error === null ? stdout : undefined)
  })
})

/**
 * The latest commit of a repository.
 * @param folder - a folder whose `.git` is a directory inside it.
 * @param read - runs Git; the installed `git` outside tests.
 * @param environment - the process environment the run takes `PATH` and `HOME` from.
 * @returns the subject and time of `HEAD`, or undefined for a repository with no commit, a missing `git`, a repository
 * Git refuses to read, or output that does not parse.
 */
export async function lastCommitOf(folder: string, read: GitReader = runGit, environment: NodeJS.ProcessEnv = process.env): Promise<LastCommit | undefined> {
  const env: Record<string, string> = { GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot']) {
    const value = environment[name]
    if (value !== undefined) env[name] = value
  }
  const args = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${devNull}`, '-C', folder, 'log', '-1', '--no-show-signature', '--format=%ct%x09%s']
  const output = await read(args, env)
  const match = /^(\d{1,12})\t([^\r\n]*)/u.exec(output ?? '')
  if (match === null) return undefined
  const subject = (match[2] as string).replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, MAX_COMMIT_SUBJECT)
  const seconds = Number(match[1])
  return subject === '' ? undefined : { subject, at: new Date(seconds * 1000).toISOString() }
}
