/**
 * Build-script approval for `delorun plugin`: when pnpm refuses to run a package's build, as it does for the `prepare`
 * script of a plugin installed from git and for a native dependency's install script, `delorun plugin` offers to allow
 * that one package's build and runs the operation again.
 *
 * - Upstream's `dsh plugin` gives pnpm the terminal itself and keeps none of its output, so for `add`, `install` and
 *   `update` (not `--interactive`) `delorun plugin` runs pnpm through a small Node wrapper ({@link capturingPackageManager})
 *   that passes pnpm's output through to the terminal unchanged in content and keeps a copy, at most
 *   {@link CAPTURE_LIMIT_BYTES}, in a file under the profile's run directory, mode 0600, removed afterwards.
 * - The refusal is read from that copy with upstream's `blockedBuildNames`, which the studio's plugin manager uses too;
 *   the names it reports are recorded as undecided under `allowBuilds` in the profile's `pnpm-workspace.yaml`
 *   (`recordPendingBuilds`), as the studio records them.
 * - Each name is allowed only by the person: a terminal confirmation that starts on no, or `--allow-build <name>`,
 *   which names the package and matches the exact key pnpm printed for it (`<name>` or `<name>@<source>`). Nothing
 *   allows every build, a wildcard or a pattern; a name refused or left undecided stays undecided.
 * - An allowed key is written as `true` through upstream's `approveBuilds` under the profile's `package.json` file
 *   lock, the lock every profile package operation holds.
 *
 * Allowing a build runs that package's code on this computer at install time with the person's own access, outside
 * the sandbox Delorun runs commands in; the confirmation says so.
 *
 * @module @delorun/cli/plugin-builds
 */
import { open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { confirm, isCancel } from '@clack/prompts'
import type { ProfilePnpmInvocation } from '@deepseek-ai/dsh-app-boot'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { approveBuilds, blockedBuildNames, recordPendingBuilds } from '@deepseek-ai/dsh-plugin-manager/operations'
import { CliError, EXIT } from './exit.ts'
import { printable } from './terminal-text.ts'

/** The Delorun option of `delorun plugin` that allows one package's build without a prompt. */
export const ALLOW_BUILD_OPTION = '--allow-build'

/** The most of pnpm's output the wrapper keeps, and the most `delorun plugin` reads back. */
export const CAPTURE_LIMIT_BYTES = 4_194_304

/** The pnpm commands whose output is kept: the ones that install packages and so may run their builds. */
const INSTALLING_COMMANDS: ReadonlySet<string> = new Set(['add', 'install', 'i', 'update', 'up', 'upgrade'])

/**
 * The wrapper, run as `node -e`: it runs the package manager given after the capture file with the inherited
 * standard input, writes pnpm's output to its own output as it arrives and appends it to the file until the file holds
 * {@link CAPTURE_LIMIT_BYTES}, and ends with pnpm's exit code (127 when pnpm cannot be found) once its output is written. It keeps colour on when its
 * own output is a terminal.
 */
const CAPTURE_SOURCE = [
  "const { spawn } = require('node:child_process')",
  "const { openSync, writeSync, closeSync } = require('node:fs')",
  "const { isAbsolute } = require('node:path')",
  'const [file, command, ...args] = process.argv.slice(1)',
  "const fd = openSync(file, 'a', 0o600)",
  `let left = ${String(CAPTURE_LIMIT_BYTES)}`,
  "const env = process.stdout.isTTY ? { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' } : process.env",
  "const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'], env, shell: process.platform === 'win32' && !isAbsolute(command) })",
  'const pass = (stream) => (chunk) => { stream.write(chunk); if (left > 0) { const part = chunk.subarray(0, left); writeSync(fd, part); left -= part.length } }',
  "child.stdout.on('data', pass(process.stdout))",
  "child.stderr.on('data', pass(process.stderr))",
  'let failed',
  "child.on('error', (error) => { failed = error.code === 'ENOENT' ? 127 : 1 })",
  "child.on('close', (code) => { closeSync(fd); process.exitCode = failed ?? code ?? 1 })",
].join('\n')

/**
 * Whether `delorun plugin` keeps pnpm's output for these arguments: an installing command that is not interactive,
 * since an interactive pnpm needs the terminal as its output.
 * @param args - the arguments upstream's `dsh plugin` receives, `--profile` included.
 * @returns true for `add`, `install`, `i`, `update`, `up` and `upgrade` without `-i` or `--interactive`.
 */
export function capturesOutput(args: readonly string[]): boolean {
  let command: string | undefined
  for (let at = 0; at < args.length && command === undefined; at++) {
    const argument = args[at]!
    if (argument === '--profile') at++
    else if (!argument.startsWith('-')) command = argument
  }
  return command !== undefined && INSTALLING_COMMANDS.has(command) && !args.includes('-i') && !args.includes('--interactive')
}

/**
 * The package manager invocation that runs the real one through the wrapper, keeping its output in a file.
 * @param real - the pnpm `delorun plugin` runs: an installed Delorun's own, or `undefined` for `pnpm` on `PATH`.
 * @param file - the file that keeps the output.
 * @returns the invocation upstream's `dsh plugin` runs instead.
 */
export function capturingPackageManager(real: ProfilePnpmInvocation | undefined, file: string): ProfilePnpmInvocation {
  return {
    command: process.execPath,
    args: ['-e', CAPTURE_SOURCE, file, real?.command ?? 'pnpm', ...real?.args ?? []],
    env: real?.env ?? {},
  }
}

/**
 * Read what the wrapper kept, and remove its file.
 * @param file - the file.
 * @returns the output; empty when the file does not exist.
 */
export async function takeCapture(file: string): Promise<string> {
  let handle
  try {
    handle = await open(file, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, CAPTURE_LIMIT_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
    await rm(file, { force: true })
  }
}

/**
 * Asks the person whether to allow one build.
 * @param question - the question, naming the package and what allowing it means.
 * @returns true to allow it.
 */
export type ConfirmBuild = (question: string) => Promise<boolean>

/**
 * The terminal's confirmation, which starts on no; without a terminal on both standard input and output, `undefined`.
 * @returns the confirmation, or `undefined` when no one can answer it.
 */
export function terminalConfirm(): ConfirmBuild | undefined {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return undefined
  return async (question) => {
    const answer = await confirm({ message: question, initialValue: false })
    return !isCancel(answer) && answer
  }
}

/** A `delorun plugin` command line with its Delorun options taken out. */
export interface PluginArguments {
  /** The arguments upstream's `dsh plugin` receives. */
  readonly args: readonly string[]
  /** The package names `--allow-build` named, in order. */
  readonly allowed: readonly string[]
}

/**
 * Take `--allow-build <name>` and `--allow-build=<name>` out of the arguments before `--`; they never reach pnpm, whose
 * own flag of that name writes a name-only key that does not admit a git package's `prepare` script.
 * @param args - the arguments after `plugin`.
 * @returns the arguments for upstream and the names to allow.
 * @throws {CliError} with the usage code for a missing or empty name, a wildcard (`*` or `?`) or a `!` prefix.
 */
export function takeAllowBuild(args: readonly string[]): PluginArguments {
  const rest: string[] = []
  const allowed: string[] = []
  for (let at = 0; at < args.length; at++) {
    const argument = args[at]!
    if (argument === '--') {
      rest.push(...args.slice(at))
      break
    }
    let name: string | undefined
    if (argument === ALLOW_BUILD_OPTION) name = args[++at] ?? ''
    else if (argument.startsWith(`${ALLOW_BUILD_OPTION}=`)) name = argument.slice(ALLOW_BUILD_OPTION.length + 1)
    if (name === undefined) {
      rest.push(argument)
      continue
    }
    if (name === '' || name.startsWith('-')) throw new CliError(EXIT.usage, `delorun plugin: ${ALLOW_BUILD_OPTION} needs the name of the one package whose build to allow`)
    if (/[*?]/.test(name) || name.startsWith('!')) throw new CliError(EXIT.usage, `delorun plugin: ${ALLOW_BUILD_OPTION} ${JSON.stringify(name)} is refused: name one package, without * or ? or a leading !`)
    allowed.push(name)
  }
  return { args: rest, allowed }
}

/**
 * Whether `--allow-build <name>` names an `allowBuilds` key pnpm printed: the key is the name, or the name followed
 * by `@` and the version or source pnpm resolved.
 * @param key - the key.
 * @param name - the name.
 * @returns true when the name selects the key.
 */
export function namesKey(key: string, name: string): boolean {
  return key === name || key.startsWith(`${name}@`)
}

/**
 * The package name an `allowBuilds` key starts with.
 * @param key - the key, `<name>` or `<name>@<version or source>`.
 * @returns the name.
 */
export function packageNameOf(key: string): string {
  return key.replace(/(?<=.)@.*$/s, '')
}

/** What became of the builds a failed operation reported as refused. */
export interface BuildDecision {
  /** The keys allowed now, by the person's answer or `--allow-build`. */
  readonly allowed: readonly string[]
  /** The keys left undecided. */
  readonly undecided: readonly string[]
}

/** Where the decision reads and writes. */
export interface BuildApprovalRequest {
  /** The profile's directory. */
  readonly profileDir: string
  /** pnpm's output of the failed operation. */
  readonly output: string
  /** The names `--allow-build` gave. */
  readonly allowed: readonly string[]
  /** The terminal's confirmation, or `undefined` without a terminal. */
  readonly confirm: ConfirmBuild | undefined
  /** Where the explanation goes. */
  readonly stderr: (text: string) => void
}

/**
 * The question for one key.
 * @param key - the `allowBuilds` key pnpm printed.
 * @returns the question.
 */
export function buildQuestion(key: string): string {
  return `pnpm did not run the build script of ${printable(key)}. Allowing it runs that package's code on this computer, now and at each later install, with your access and outside the sandbox Delorun runs commands in. Allow this one package's build?`
}

/**
 * After a failed operation, record the builds pnpm refused as undecided and allow each one the person allows.
 * @param request - the profile, pnpm's output, the names given and the confirmation.
 * @returns the keys allowed and the keys left undecided; both empty when pnpm refused no build.
 * @throws {Error} upstream's refusal when the profile's `pnpm-workspace.yaml` is not a mapping, or its `allowBuilds`
 *   holds YAML anchors or aliases; nothing is written then.
 */
export async function decideBuilds(request: BuildApprovalRequest): Promise<BuildDecision> {
  const { output } = request
  const blocked = blockedBuildNames(output)
  if (blocked.length === 0) return { allowed: [], undecided: [] }
  const allowed: string[] = []
  await withFileLock(join(request.profileDir, 'package.json'), async () => {
    const pending = await recordPendingBuilds(request.profileDir, output)
    for (const key of blocked.filter(name => pending.includes(name))) {
      if (request.allowed.some(name => namesKey(key, name))) {
        request.stderr(`delorun plugin: allowing the build of ${printable(key)}, as ${ALLOW_BUILD_OPTION} asked. It runs that package's code on this computer with your access, outside the sandbox Delorun runs commands in.\n`)
        allowed.push(key)
      } else if (request.confirm !== undefined && await request.confirm(buildQuestion(key))) {
        allowed.push(key)
      }
    }
    await approveBuilds(request.profileDir, allowed)
  }, { waitMs: 120_000 })
  const undecided = blocked.filter(key => !allowed.includes(key))
  for (const key of undecided) {
    request.stderr(`delorun plugin: the build of ${printable(key)} is not allowed, so the operation stopped. To allow that one package's build, run the command again with ${ALLOW_BUILD_OPTION} ${printable(packageNameOf(key))}.\n`)
  }
  return { allowed, undecided }
}
