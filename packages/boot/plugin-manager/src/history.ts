/**
 * The profile's history: a git repository whose work tree is the profile
 * directory and whose git directory is `.plugin-manager/history`, so it never
 * meets a repository the person keeps in the profile. It tracks only the
 * files plugin management writes; each version is one commit whose subject is
 * the change's summary and whose `Changed-by` and `Session` trailers say who
 * made it. git runs with no system or global configuration and no hooks.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { devNull } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { PROFILE_COMPATIBILITY_FILENAME } from '@deepseek-ai/dsh-app-boot'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProfileChangedBy, ProfileVersion, ProfileVersionId } from './types.ts'

export type { ProfileChangedBy, ProfileVersion, ProfileVersionId } from './types.ts'

/** The profile files plugin management writes, relative to the profile directory: the files the history tracks. */
export const PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'pnpm-workspace.yaml', PROFILE_COMPATIBILITY_FILENAME] as const

/** The lockfile, whose change means a restored version's dependency set must be installed again. */
const LOCKFILE = 'pnpm-lock.yaml'

/**
 * Write one version's files into the profile, as {@link ProfileHistory.filesAt} read them: each held file replaced
 * whole, at mode 0600, and each file the version does not hold removed. The dependency set is not installed.
 * @param dir - the profile directory.
 * @param files - the version's files, by name relative to `dir`.
 * @returns whether the lockfile differs from the one it replaced, so `pnpm install --frozen-lockfile` must run.
 */
export async function writeProfileVersion(dir: string, files: ReadonlyMap<string, string | undefined>): Promise<boolean> {
  const lockfile = join(dir, LOCKFILE)
  const before = existsSync(lockfile) ? await readFile(lockfile, 'utf8') : undefined
  for (const [name, content] of files) {
    if (content === undefined) await rm(join(dir, name), { force: true })
    else await writeFileAtomic(join(dir, name), content, { mode: 0o600 })
  }
  return files.get(LOCKFILE) !== before
}

/** The history's git directory, relative to the profile directory. */
export const HISTORY_DIR = join('.plugin-manager', 'history')

/** The most versions one {@link ProfileHistory.list} reads. */
export const MAX_LIST = 2 ** 31 - 1

/** The identity every version is committed under; who made a change is its `Changed-by` trailer. */
const IDENTITY = { name: 'DSH plugin management', email: 'plugin-manager@dsh.invalid' }

/** Separates `git log` fields and records; neither occurs in a summary git accepts. */
const FIELD = '\u001f'
const RECORD = '\u001e'

/**
 * Decides whether one version may be saved, from the files it would hold.
 * @param files - the text of every file the version would hold, by name relative to the profile, or undefined for an
 *   absent file: the caller's managed files, every file the history's exclusions admit and every file it tracks.
 * @returns undefined to save the version, or why it may not be saved.
 */
export type VersionAdmission = (files: ReadonlyMap<string, string | undefined>) => string | undefined

/** One git run's exit code and output. */
interface GitRun { exitCode: number; stdout: string }

/** git is missing or failed in a way the history cannot work around. */
export class HistoryUnavailableError extends Error {
  /**
   * @param message - what failed, for the person.
   * @param options - the underlying error.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HistoryUnavailableError'
  }
}

/** A version the history's admission refused, or could not decide on; nothing was staged or saved. */
export class VersionRefusedError extends HistoryUnavailableError {
  /** Why the version was not saved, as the admission gave it. */
  readonly reason: string

  /**
   * @param reason - the admission's reason.
   * @param options - the admission's own failure, when it threw.
   */
  constructor(reason: string, options?: ErrorOptions) {
    super(`this version of the profile was not saved: ${reason}`, options)
    this.name = 'VersionRefusedError'
    this.reason = reason
  }
}

/** Reads and writes the versions of a profile's managed files; every failure is a {@link HistoryUnavailableError}. */
export class ProfileHistory {
  private readonly gitDir: string

  /**
   * @param dir - the profile directory, the history's work tree.
   * @param files - the managed files the history tracks, relative to `dir`.
   * @param gitCommand - the git executable name or path, resolved through `PATH`.
   * @param timeoutMs - the bound on one git run.
   * @param admit - decides before each version whether it may be saved; every version is saved without one.
   */
  constructor(
    private readonly dir: string,
    private readonly files: readonly string[],
    private readonly gitCommand: string,
    private readonly timeoutMs: number,
    private readonly admit?: VersionAdmission,
  ) {
    this.gitDir = join(dir, HISTORY_DIR)
  }

  /**
   * Save the managed files as a new version when they differ from the latest one; the first call starts the history.
   * @param summary - what changed, not blank; whitespace runs become one space.
   * @param changedBy - who changed it.
   * @returns the new version's id, or undefined when nothing changed.
   * @throws HistoryUnavailableError when git cannot run or refuses; {@link VersionRefusedError} when the admission
   *   refuses the version or throws, and nothing is staged or saved then.
   */
  async record(summary: string, changedBy: ProfileChangedBy): Promise<ProfileVersionId | undefined> {
    await this.ensure()
    if (this.admit === undefined) await this.git(['add', '--all', '--', '.'])
    else await this.stageAdmitted(this.admit)
    if ((await this.git(['diff', '--cached', '--quiet'], [0, 1])).exitCode === 0) return undefined
    const trailers = [`Changed-by: ${changedBy.kind}`, ...changedBy.kind === 'agent' ? [`Session: ${changedBy.sessionId}`] : []]
    await this.git(['commit', '--quiet', '--no-verify', '-m', oneLine(summary), '-m', trailers.join('\n')])
    return brandString<ProfileVersionId>((await this.git(['rev-parse', 'HEAD'])).stdout.trim())
  }

  /**
   * The versions, newest first.
   * @param limit - the most to read, from 1 to {@link MAX_LIST}.
   * @returns each version with when, what and who; empty before the first.
   * @throws HistoryUnavailableError when git cannot run or refuses.
   */
  async list(limit: number): Promise<ProfileVersion[]> {
    // git reads `--max-count` as a 32-bit integer and refuses anything larger.
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) throw new RangeError(`limit must be an integer from 1 to ${String(MAX_LIST)}`)
    if (!existsSync(this.gitDir)) return []
    if ((await this.git(['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1])).exitCode !== 0) return []
    return this.log(['--max-count', String(limit)])
  }

  /**
   * One version, by its id.
   * @param id - the version.
   * @returns the version, or undefined when the history does not hold it.
   * @throws HistoryUnavailableError when git cannot run or refuses.
   */
  async version(id: ProfileVersionId): Promise<ProfileVersion | undefined> {
    if (!(await this.holds(id))) return undefined
    return (await this.log(['--max-count', '1', id]))[0]
  }

  /**
   * Read every file a version would hold once, ask the admission about exactly that text, and stage exactly that text,
   * so an edit made after the read never reaches the version. The files are the managed ones, every name the
   * exclusions admit, which a caller managing more files may have added, and every file the history tracks.
   */
  private async stageAdmitted(admit: VersionAdmission): Promise<void> {
    const exclusions = (await readFile(join(this.gitDir, 'info', 'exclude'), 'utf8')).split('\n')
    const tracked = (await this.git(['ls-files', '-z'])).stdout.split('\0')
    const names = [...new Set([...this.files, ...exclusions.filter(line => line.startsWith('!/')).map(line => line.slice(2)), ...tracked])]
      .filter(name => name !== '')
    const files = new Map<string, string | undefined>()
    for (const name of names) {
      try {
        files.set(name, await readFile(join(this.dir, name), 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new HistoryUnavailableError(`${name} cannot be read: ${(error as Error).message}`, { cause: error })
        files.set(name, undefined)
      }
    }
    let refusal: string | undefined
    try {
      refusal = admit(new Map(files))
    } catch (error) {
      throw new VersionRefusedError(`the check of this version failed: ${(error as Error).message}`, { cause: error })
    }
    if (refusal !== undefined) throw new VersionRefusedError(refusal)
    for (const [name, text] of files) {
      if (text === undefined) {
        await this.git(['update-index', '--force-remove', '--', name])
        continue
      }
      const blob = (await this.git(['hash-object', '-w', '--stdin'], [0], text)).stdout.trim()
      await this.git(['update-index', '--add', '--cacheinfo', `100644,${blob},${name}`])
    }
  }

  // Whether the history holds a version with this id: a commit that its latest version reaches.
  private async holds(id: string): Promise<boolean> {
    if (!/^[0-9a-f]{40}$/.test(id) || !existsSync(join(this.gitDir, 'HEAD'))) return false
    if ((await this.git(['cat-file', '-e', `${id}^{commit}`], [0, 1, 128])).exitCode !== 0) return false
    return (await this.git(['merge-base', '--is-ancestor', id, 'HEAD'], [0, 1])).exitCode === 0
  }

  private async log(range: readonly string[]): Promise<ProfileVersion[]> {
    const format = ['%H', '%ct', '%s', '%(trailers:key=Changed-by,valueonly,separator=)', '%(trailers:key=Session,valueonly,separator=)'].join(FIELD)
    const { stdout } = await this.git(['log', ...range, `--format=${format}${RECORD}`])
    return stdout.split(RECORD).map(record => record.trim()).filter(record => record !== '').map((record) => {
      // The format writes exactly five fields per record.
      const [id, at, summary, by, session] = record.split(FIELD) as [string, string, string, string, string]
      return { id: brandString<ProfileVersionId>(id), at: Number(at) * 1000, summary, changedBy: changedByOf(by.trim(), session.trim()) }
    })
  }

  /**
   * The managed files as one version holds them.
   * @param id - the version.
   * @returns each tracked file's text, or undefined for a file the version does not hold.
   * @throws HistoryUnavailableError when git cannot run or the version is not one of the history's.
   */
  async filesAt(id: ProfileVersionId): Promise<Map<string, string | undefined>> {
    if (!(await this.holds(id))) throw new HistoryUnavailableError(`no profile version ${id}`)
    const held = new Set((await this.git(['ls-tree', '--name-only', id])).stdout.split('\n'))
    const files = new Map<string, string | undefined>()
    for (const name of this.files) files.set(name, held.has(name) ? (await this.git(['show', `${id}:${name}`])).stdout : undefined)
    return files
  }

  /**
   * Whether a managed file was part of any version up to and including one: false when every version up to it was
   * written before the history admitted the file, or before the file existed.
   * @param id - the version.
   * @param name - the managed file, relative to the profile.
   * @returns true when a version at or before `id` added, changed or removed the file.
   * @throws HistoryUnavailableError when git cannot run or the version is not one of the history's.
   */
  async trackedBy(id: ProfileVersionId, name: string): Promise<boolean> {
    if (!(await this.holds(id))) throw new HistoryUnavailableError(`no profile version ${id}`)
    return (await this.git(['log', '--max-count', '1', '--format=%H', id, '--', name])).stdout.trim() !== ''
  }

  /**
   * Create the git directory and its exclusions, which admit only the managed files, once. A history that exists already
   * may have been created by a caller that manages fewer files; its exclusions then gain every managed file they do not
   * admit, so this caller's files are part of every version from the next one on. Exclusions only ever widen, and the
   * file is replaced whole, never left without its first line that excludes everything else in the profile.
   */
  private async ensure(): Promise<void> {
    if (existsSync(join(this.gitDir, 'HEAD'))) {
      await this.admitManagedFiles()
      return
    }
    try {
      await mkdir(join(this.gitDir, 'info'), { recursive: true, mode: 0o700 })
      await writeFileAtomic(join(this.gitDir, 'info', 'exclude'), ['/*', ...this.files.map(name => `!/${name}`), ''].join('\n'), { mode: 0o600 })
    } catch (error) {
      throw new HistoryUnavailableError(`the history directory cannot be made: ${(error as Error).message}`, { cause: error })
    }
    // git init keeps the exclusions already written.
    await this.git(['init', '--quiet'])
  }

  /**
   * Add to an existing history's exclusions every managed file they do not admit, and put back the first line that
   * excludes everything else when it is missing, so a lost or damaged file never lets a version hold the whole profile.
   */
  private async admitManagedFiles(): Promise<void> {
    const path = join(this.gitDir, 'info', 'exclude')
    let lines: string[]
    try {
      lines = (await readFile(path, 'utf8')).split('\n').filter(line => line !== '')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new HistoryUnavailableError(`the history's exclusions cannot be read: ${(error as Error).message}`, { cause: error })
      lines = []
    }
    const missing = this.files.filter(name => !lines.includes(`!/${name}`))
    if (lines[0] === '/*' && missing.length === 0) return
    // Later lines win, so the line that excludes everything comes first and every admission after it.
    const next = ['/*', ...lines.filter(line => line !== '/*'), ...missing.map(name => `!/${name}`), '']
    try {
      await writeFileAtomic(path, next.join('\n'), { mode: 0o600 })
    } catch (error) {
      throw new HistoryUnavailableError(`the history's exclusions cannot be written: ${(error as Error).message}`, { cause: error })
    }
  }

  private async git(args: readonly [string, ...string[]], accepted: readonly number[] = [0], input?: string): Promise<GitRun> {
    // With `reject: false`, a git that cannot start or is ended by the timeout resolves with no exit code.
    const options = ['-c', `core.hooksPath=${devNull}`, '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false']
    const run = await execa(this.gitCommand, [...options, ...args], {
      cwd: this.dir, reject: false, stripFinalNewline: false, timeout: this.timeoutMs, ...input === undefined ? {} : { input },
      env: {
        GIT_DIR: this.gitDir, GIT_WORK_TREE: this.dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email,
        GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email,
      },
    })
    const { exitCode } = run
    if (exitCode === undefined) throw new HistoryUnavailableError(`git could not run: ${run.shortMessage}`)
    if (!accepted.includes(exitCode)) throw new HistoryUnavailableError(`git ${args[0]} failed with exit code ${String(exitCode)}: ${run.stderr.trim()}`)
    return { exitCode, stdout: run.stdout }
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function changedByOf(kind: string, session: string): ProfileChangedBy {
  if (kind === 'agent' && session !== '') return { kind: 'agent', sessionId: session }
  if (kind === 'person' || kind === 'outside') return { kind }
  // A version committed by hand, outside plugin management, names no one the manager knows.
  return { kind: 'outside' }
}
