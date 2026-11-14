/**
 * Delorun's version, upstream's version, and the output of `delorun --version` (contract C17, "Version
 * output"). Delorun's version is the CLI package manifest's `version`, which a release stamps from the release
 * manifest's `version` (contract C02), read the way upstream reads app-boot's; upstream's is
 * `@deepseek-ai/dsh-app-boot`'s own version, through upstream's `getDshRuntimeVersion()`. Both are semantic
 * versions, and this module refuses to report one it cannot validate rather than print a number it cannot
 * stand behind.
 *
 * Every `delorun` invocation exports Delorun's version as {@link DELORUN_VERSION_ENV} before any upstream module
 * runs, so the profile preflight and the plugin manager can check a plugin's `engines.delorun` against the
 * Delorun that is actually running (contract C17, "Evaluation"), and every child process inherits it.
 *
 * @module @delorun/cli/version
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { DELORUN_VERSION_ENV, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import type { SemanticVersion } from '@delorun/contract-release-manifest'
import { VERSION_OUTPUT_LABELS, type VersionOutput } from '@delorun/contract-plugin-versions'
import { EXIT, type ExitCode } from './exit.ts'
import { parseOptions, type CommandContext } from './command.ts'

/** The name of the file this module is in, for its messages: `version.ts`. */
const MODULE = 'version.ts'

/** A version Delorun cannot read or validate, naming where it was read from and what to do about it. */
export class DelorunVersionError extends Error {
  /** The file or variable the version was read from. */
  readonly source: string

  /**
   * @param source - the file or variable the version was read from.
   * @param message - what is wrong with it and what to do.
   */
  constructor(source: string, message: string) {
    super(message)
    this.source = source
    this.name = 'DelorunVersionError'
  }
}

/**
 * Read Delorun's version from a package manifest.
 * @param filename - the manifest to read; the CLI package's `package.json` by default.
 * @returns the validated version, preserving its exact spelling.
 * @throws {DelorunVersionError} when the manifest cannot be read, carries no `version`, or carries one that is not a semantic version.
 */
export function delorunVersion(filename: string = fileURLToPath(new URL('../package.json', import.meta.url))): SemanticVersion {
  let manifest: unknown
  try {
    manifest = JSON.parse(fs.readFileSync(filename, 'utf8'))
  } catch (error) {
    throw new DelorunVersionError(filename, `${MODULE}: Delorun's version cannot be read from ${filename} (${error instanceof Error ? error.message : String(error)}); reinstall Delorun, or report the damaged installation, because delorun cannot tell which Delorun this is.`)
  }
  const value = typeof manifest === 'object' && manifest !== null && Object.hasOwn(manifest, 'version')
    ? (manifest as Record<string, unknown>).version
    : undefined
  if (typeof value !== 'string' || semver.valid(value) === null) {
    throw new DelorunVersionError(filename, `${MODULE}: Delorun's version in ${filename} is ${JSON.stringify(value)}, which is not a semantic version such as 1.0.0; reinstall Delorun.`)
  }
  return value as SemanticVersion
}

/**
 * Read upstream's version the way upstream does.
 * @returns the running `@deepseek-ai/dsh-app-boot` version.
 * @throws {DelorunVersionError} when upstream's reader rejects it.
 */
export function dshVersion(): SemanticVersion {
  try {
    return getDshRuntimeVersion() as SemanticVersion
  } catch (error) {
    throw new DelorunVersionError('@deepseek-ai/dsh-app-boot', `${MODULE}: DSH's version cannot be read from @deepseek-ai/dsh-app-boot (${error instanceof Error ? error.message : String(error)}); reinstall Delorun.`)
  }
}

/**
 * The two versions Delorun reports.
 * @returns Delorun's version and the DSH version it runs on.
 * @throws {DelorunVersionError} when either cannot be read.
 */
export function versions(): VersionOutput {
  return { delorun: delorunVersion(), dsh: dshVersion() }
}

/**
 * The two lines `delorun --version` prints (contract C17): `Delorun <delorun>`, then `DSH <dsh>`.
 * @param output - the versions.
 * @returns the lines, each ending in a newline.
 */
export function versionLines(output: VersionOutput): string {
  return `${VERSION_OUTPUT_LABELS[0]} ${output.delorun}\n${VERSION_OUTPUT_LABELS[1]} ${output.dsh}\n`
}

/**
 * The single line `delorun --version --json` prints (contract C17).
 * @param output - the versions.
 * @returns one JSON object line.
 */
export function versionJson(output: VersionOutput): string {
  return `${JSON.stringify({ delorun: output.delorun, dsh: output.dsh })}\n`
}

/**
 * Export Delorun's version to this process and its children, as {@link DELORUN_VERSION_ENV}, before any upstream
 * module reads it.
 * @param env - the environment to change; this process's by default.
 * @throws {DelorunVersionError} when Delorun's own version cannot be read, because a Delorun that cannot say which
 * version it is must not check plugins against a version it guessed.
 */
export function applyDelorunVersionEnvironment(env: Record<string, string | undefined> = process.env): void {
  env[DELORUN_VERSION_ENV] = delorunVersion()
}

/**
 * `delorun --version [--json]`.
 * @param args - the arguments after `--version`.
 * @param context - the output.
 * @param output - the versions to print; read from the installation by default.
 * @returns the exit code, 0 when it printed and 2 for a wrong option.
 */
export function versionCommand(args: readonly string[], context: CommandContext, output: VersionOutput = versions()): ExitCode {
  const values = parseOptions('', args, { json: { type: 'boolean', default: false } })
  context.stdout(values.json === true ? versionJson(output) : versionLines(output))
  return EXIT.ok
}
