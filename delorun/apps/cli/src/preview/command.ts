/**
 * `delorun preview list | on <flag> | off <flag>`: the preview flags of a profile (`@delorun/preview-flags`). A flag is
 * a studio feature a plugin declares as not ready for everyone; it is off until the profile's `delorun-preview-flags`
 * row turns it on.
 *
 * - `list` shows each flag the profile's plugins list, whether it is on, and the plugin that declares it.
 * - `on` and `off` write the row's `flags` in the profile's own `cordis.patch.yml`, holding the profile's writer lock.
 *   `on` refuses a flag no plugin of the profile lists, naming the known flags; `off` also removes a flag that is
 *   set and no longer known, which the row refuses to load with.
 *
 * The command reads the composed rows and the manifests of the packages they load from, so it works while Delorun is
 * stopped. A change applies from the next start.
 *
 * @module @delorun/cli/preview/command
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { composeEntries, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { knownList } from '@delorun/preview-flags/flags'
import { packageOf, readFlagIndex, rowPackages, type FlagIndex } from '@delorun/preview-flags/manifest'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { parseCommandLine, prepareHome, type CliCommand, type CommandOutput } from '../command.ts'
import { closestMatch } from '../output.ts'
import { composedRow, isRecord, patchLayers } from '../patch-layers.ts'
import { profileDirectory } from '../profile.ts'
import { homeRuns } from '../reach/command.ts'
import { readPatchRow, setPatchRow } from '@delorun/setup-apply'
import { printable } from '../terminal-text.ts'

/** The row's id in `@delorun/bundle-studio`'s patch; a spec holds it equal to the package's own constant. */
export const PREVIEW_FLAGS_ROW = 'delorun-preview-flags'

/** The usage line. */
export const PREVIEW_USAGE = 'Usage: delorun preview list | on <flag> | off <flag> [--profile <name>]'

/** What the command runs against. */
export interface PreviewDependencies {
  /**
   * The installation's `package.json`, which bundles resolve from first.
   * @returns its path.
   */
  readonly installAnchor: () => Promise<string>
  /**
   * Whether the profile's home process runs.
   * @param home - the Delorun home.
   * @param profile - the CLI profile.
   * @returns true when a live process holds its lock.
   */
  readonly running: (home: string, profile: string) => boolean
}

/** One run's profile. */
export interface PreviewRequest {
  readonly home: string
  readonly profile: string
  readonly profileDir: string
  readonly installAnchor: string
  /** Whether the profile's home process runs. */
  readonly running: boolean
  readonly output: CommandOutput
}

/** One composed row: the module it loads and whether a patch disables it. */
interface ComposedRow {
  readonly name: unknown
  readonly disabled: unknown
}

/** The profile as the command reads it. */
interface PreviewProfile {
  readonly patchPath: string
  /** Every composed row, the rows of groups included. */
  readonly rows: readonly ComposedRow[]
  readonly index: FlagIndex
  /** The composed row's `flags`. */
  readonly flags: Readonly<Record<string, unknown>>
}

/**
 * Every row of a composed entry list, the members of a group included.
 * @param entries - the composed entries.
 * @returns the rows, in composition order.
 */
function allRows(entries: readonly unknown[]): ComposedRow[] {
  return entries.filter(isRecord).flatMap(entry => [
    { name: entry.name, disabled: entry.disabled },
    ...allRows(Array.isArray(entry.config) ? entry.config : []),
  ])
}

/**
 * Read the profile's flag index and its composed flags.
 * @param request - the home, the profile and the installation anchor.
 * @param action - the action, for the message.
 * @returns the profile's patch file, rows, index and flags.
 * @throws {CliError} `EXIT.failed` for a directory that holds no profile, or a profile without the row.
 */
function readProfile(request: PreviewRequest, action: string): PreviewProfile {
  if (!existsSync(join(request.profileDir, 'package.json'))) throw new CliError(EXIT.failed, `delorun preview ${action}: ${request.profileDir} holds no profile; run delorun setup first`)
  const profile = loadProfileDirectory('delorun', request.profileDir, request.installAnchor)
  const layers = patchLayers(request.home, profile, [])
  const row = composedRow(layers, PREVIEW_FLAGS_ROW)
  if (row === undefined) throw new CliError(EXIT.failed, `delorun preview ${action}: the profile ${request.profile} has no ${PREVIEW_FLAGS_ROW} row, which holds the flags; it does not load Delorun's studio bundle`)
  const rows = allRows(composeEntries(layers.map(layer => layer.patches)))
  // A row's package resolves as the Loader resolves it: from the installation, the profile, then the bundle that brings it.
  const anchors = [request.installAnchor, join(request.profileDir, 'package.json'), ...layers.flatMap(layer => (layer.packageDir === undefined ? [] : [join(layer.packageDir, 'package.json')]))]
  const index = readFlagIndex(rowPackages(rows.map(each => each.name), anchors))
  const config = isRecord(row.config) ? row.config : {}
  return { patchPath: profile.patchPath, rows, index, flags: isRecord(config.flags) ? config.flags : {} }
}

/**
 * The plugin that declares a flag, and whether it is off.
 * @param profile - the profile.
 * @param id - the flag.
 * @returns the package that lists the flag, and whether every row that loads from it is disabled.
 */
function ownerOf(profile: PreviewProfile, id: string): { readonly plugin: string, readonly off: boolean } | undefined {
  const plugin = [...profile.index.owners].find(([flag]) => flag === id)?.[1]
  if (plugin === undefined) return undefined
  return { plugin, off: !profile.rows.some(row => packageOf(row.name) === plugin && row.disabled !== true) }
}

/**
 * Print each package whose flag list could not be read.
 * @param profile - the profile.
 * @param output - where to print.
 */
function printProblems(profile: PreviewProfile, output: CommandOutput): void {
  for (const problem of profile.index.problems) output.stderr(`delorun: warning: the preview flags of ${printable(problem.package)} were not read: ${printable(problem.message)}\n`)
}

/**
 * `delorun preview list`.
 * @param request - the profile and the output.
 * @returns {@link EXIT.ok}.
 * @throws {CliError} see {@link readProfile}.
 */
export function listPreviewFlags(request: PreviewRequest): ExitCode {
  const profile = readProfile(request, 'list')
  printProblems(profile, request.output)
  const known = [...profile.index.owners.keys()].sort()
  const unknown = Object.keys(profile.flags).filter(id => !known.some(flag => flag === id)).sort()
  if (known.length === 0 && unknown.length === 0) {
    request.output.stdout(`No plugin of the profile ${request.profile} declares a preview flag.\n`)
    return EXIT.ok
  }
  const width = Math.max(...[...known, ...unknown].map(id => id.length))
  const lines = [`Preview flags of the profile ${request.profile}:`]
  for (const id of known) {
    const owner = ownerOf(profile, id)
    const on = profile.flags[id] === true
    lines.push(`  ${id.padEnd(width)}  ${on ? 'on ' : 'off'}  ${printable(owner?.plugin ?? '')}${owner?.off === true ? on ? '  (its plugin is off, so the flag changes nothing)' : '  (its plugin is off)' : ''}`)
  }
  for (const id of unknown) lines.push(`  ${printable(id).padEnd(width)}  not a flag of this profile; Delorun's preview flags do not load with it. Remove it with: delorun preview off ${printable(id)}`)
  lines.push('', 'Turn one on with: delorun preview on <flag>')
  request.output.stdout(`${lines.join('\n')}\n`)
  return EXIT.ok
}

/**
 * `delorun preview on <flag>` and `off <flag>`: write the row's `flags` in the profile's own patch, under the profile's writer lock.
 * @param request - the profile and the output.
 * @param flag - the flag id.
 * @param on - whether to turn it on.
 * @returns {@link EXIT.ok}.
 * @throws {CliError} `EXIT.usage` for a flag the profile does not know (for `off`, one that is also not set); see {@link readProfile}.
 */
export async function setPreviewFlag(request: PreviewRequest, flag: string, on: boolean): Promise<ExitCode> {
  const action = on ? 'on' : 'off'
  // The profile's writer lock, which the plugin manager and the settings writer take for their own writes.
  return await withFileLock(join(request.profileDir, 'package.json'), async () => {
    const profile = readProfile(request, action)
    printProblems(profile, request.output)
    const known = [...profile.index.owners.keys()]
    const listed = known.some(id => id === flag)
    if (!listed && (on || !Object.hasOwn(profile.flags, flag))) {
      const near = closestMatch(flag, known)
      throw new CliError(EXIT.usage, `delorun preview ${action}: ${JSON.stringify(printable(flag))} is not a preview flag of the profile ${request.profile}.${near === undefined ? '' : ` Did you mean ${near}?`} Known flags: ${knownList(known)}`)
    }
    const own = readPatchRow(profile.patchPath, PREVIEW_FLAGS_ROW, `delorun preview ${action}`)?.['flags']
    const kept = Object.fromEntries(Object.entries(isRecord(own) ? own : {}).filter((entry): entry is [string, boolean] => entry[0] !== flag && typeof entry[1] === 'boolean'))
    setPatchRow(profile.patchPath, { id: PREVIEW_FLAGS_ROW, config: { flags: on ? { ...kept, [flag]: true } : kept } })
    const after = readProfile(request, action)
    const applies = request.running ? 'Delorun is running: stop and start it to apply the change.' : 'It applies from the next start.'
    if (on) {
      const owner = ownerOf(after, flag)
      request.output.stdout(`${flag} is on for the profile ${request.profile}. ${applies}\n`)
      if (owner?.off === true) request.output.stderr(`delorun: warning: ${printable(owner.plugin)}, which declares ${flag}, is off in this profile, so the flag changes nothing until it is on.\n`)
    } else if (after.flags[flag] === true) {
      // Another layer than the profile's own patch sets it: the home's patch applies over every profile.
      request.output.stderr(`delorun: warning: ${flag} is still on for the profile ${request.profile}: a patch other than ${profile.patchPath} sets it, such as ${join(request.home, 'cordis.patch.yml')}.\n`)
    } else {
      request.output.stdout(`${printable(flag)} is off for the profile ${request.profile}. ${applies}\n`)
    }
    return EXIT.ok
  })
}

/**
 * Build the command.
 * @param dependencies - what it runs against.
 * @returns the command.
 */
export function createPreviewCommand(dependencies: PreviewDependencies): CliCommand {
  return {
    name: 'preview',
    summary: 'Turn a preview feature of the studio on or off: list, on <flag>, off <flag>',
    async run(args, context): Promise<ExitCode> {
      const { values, positionals } = parseCommandLine('preview', args, { profile: { type: 'string' } })
      const [action, flag, extra] = positionals
      const wrong = (problem: string): CliError => new CliError(EXIT.usage, `delorun preview: ${problem}\n${PREVIEW_USAGE}`)
      if (action !== 'list' && action !== 'on' && action !== 'off') throw wrong(action === undefined ? 'name an action' : `${JSON.stringify(printable(action))} is not an action`)
      if (action === 'list' ? flag !== undefined : flag === undefined || extra !== undefined) throw wrong(action === 'list' ? 'list takes no flag' : 'name one flag')
      const { home, profile } = await prepareHome(context, values.profile, true)
      const request: PreviewRequest = {
        home: home.path, profile, profileDir: profileDirectory(home.path, profile), installAnchor: await dependencies.installAnchor(),
        running: dependencies.running(home.path, profile), output: context,
      }
      return flag === undefined ? listPreviewFlags(request) : await setPreviewFlag(request, flag, action === 'on')
    },
  }
}

/** The command over the real installation. */
export const previewCommand: CliCommand = createPreviewCommand({
  installAnchor: async () => (await import('@deepseek-ai/dsh/profile-boot')).INSTALL_ANCHOR,
  running: homeRuns,
})
