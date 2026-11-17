/**
 * `delorun setup export` and `delorun setup import`: one signed archive of a profile's setup, and the import of one.
 *
 * Export writes the plugins the person added, the model choices and the settings that travel, never a key, a chat, a
 * device, an exemption or an answer of setup. Import verifies the archive and shows who signed it, or that nobody
 * could be shown to have, then lists everything it would change, including every plugin and setting it would remove,
 * and asks. It applies only through Changes' plugin requests, so the install checks, the build-script holds and the
 * review of a local plugin's code are the ones a hand install meets.
 *
 * @module @delorun/cli/changes/setup-transfer
 */
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { ArchiveError, ArchiveImporter, DirectoryWorkspaceStore, exportSetupArchive, keyFingerprint, loadHomeKey, signManifest, type OpenedSetup } from '@delorun/archive'
import { attestTerminal, isChangesError, readProtection, type ChangesContext, type AtComputer } from '@delorun/changes'
import { applySetupImport, collectSetup, planSetupImport, type CollectOptions, type ImportOptions, type SetupPlan } from '@delorun/changes/setup-transfer'
import { printable, quoted } from '../terminal-text.ts'
import { parseFailure, prepareHome, type CommandContext, type CommandResult } from '../command.ts'
import type { ChangesCommandDependencies } from './command.ts'
import { terminalDependencies } from './command.ts'
import { CliError, EXIT } from '../exit.ts'
import { writeNewFile } from '../export/index.ts'
import { IMPORT_LIMITS, readArchiveFile } from '../import/index.ts'
import { hasCliProfile, profileDirectory } from '../profile.ts'
import { groupsOfFour } from '../output.ts'
import { isYes } from '../trash/terminal.ts'
import { delorunVersion } from '../version.ts'
import { runningRelease } from './start.ts'

/** The usage lines. */
export const SETUP_TRANSFER_USAGE = [
  'Usage: delorun setup export --out <file> [--no-settings] [--plugin <name>]... [--no-local-code] [--note <text>] [--verbose] [--profile <name>]',
  '       delorun setup import <file> [--dry-run] [--no-settings] [--remove-others] [--verbose] [--profile <name>]',
].join('\n')

/**
 * What a setup leaves out, as a count unless the person asked for the list or it is short.
 * @param items - the lines naming what is left out.
 * @param lead - the words before the list.
 * @param verbose - whether to list every item.
 * @returns the lines; none when nothing is left out.
 */
function leftOutLines(items: readonly string[], lead: string, verbose: boolean): string[] {
  if (items.length === 0) return []
  if (verbose || items.length <= 3) return [`${lead}:`, ...items.map(line => `  ${printable(line)}`)]
  return [`${lead}: ${plural(items.length, 'item')} that belong to this computer (--verbose lists them)`]
}

/**
 * A count with its noun.
 * @param count - the count.
 * @param noun - the singular noun.
 * @returns `1 plugin`, `2 plugins`.
 */
function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * Run `delorun setup export` or `delorun setup import`.
 * @param args - the arguments after `setup`, starting with the command word.
 * @param context - the environment and output.
 * @param dependencies - the terminal, the profile lock and the plugin operation; this process's by default.
 * @returns the exit code.
 * @throws {CliError} for a wrong command line, a profile that is not set up, a refused archive, a declined question, or a failure of the import.
 */
export async function runSetupTransfer(args: readonly string[], context: CommandContext, dependencies: ChangesCommandDependencies = terminalDependencies()): Promise<CommandResult> {
  const [word, ...rest] = args
  let parsed
  try {
    parsed = parseArgs({ args: rest, options: {
      'profile': { type: 'string' }, 'out': { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, 'verbose': { type: 'boolean', default: false }, 'no-settings': { type: 'boolean', default: false },
      'plugin': { type: 'string', multiple: true }, 'no-local-code': { type: 'boolean', default: false }, 'note': { type: 'string' }, 'remove-others': { type: 'boolean', default: false },
    }, strict: true, allowPositionals: true })
  } catch (error: unknown) {
    throw parseFailure(`setup ${String(word)}`, error)
  }
  const { home, profile } = await prepareHome(context, parsed.values.profile)
  if (!hasCliProfile(home.path, profile)) throw new CliError(EXIT.failed, `delorun setup ${String(word)}: the CLI profile ${profile} is not set up in ${home.path}; run: delorun setup`)
  const ctx: ChangesContext = { home: home.path, profile, profileDir: profileDirectory(home.path, profile), ...runningRelease() }
  if (word === 'export') {
    const out = parsed.values.out
    if (out === undefined && parsed.positionals.length > 0) throw new CliError(EXIT.usage, '--out is missing: delorun setup export --out <file>')
    if (parsed.positionals.length > 0 || out === undefined || out.length === 0 || parsed.values['dry-run'] || parsed.values['remove-others']) throw new CliError(EXIT.usage, SETUP_TRANSFER_USAGE)
    const chosen = parsed.values.plugin
    return runExport(ctx, out, {
      settings: !parsed.values['no-settings'], localCode: !parsed.values['no-local-code'],
      ...chosen === undefined || chosen.length === 0 ? {} : { plugins: chosen }, ...parsed.values.note === undefined ? {} : { note: parsed.values.note },
    }, context, dependencies, parsed.values.verbose)
  }
  const [file, ...extra] = parsed.positionals
  if (file === undefined || extra.length > 0 || parsed.values.out !== undefined || parsed.values.plugin !== undefined || parsed.values['no-local-code'] || parsed.values.note !== undefined) throw new CliError(EXIT.usage, SETUP_TRANSFER_USAGE)
  return runImport(ctx, file, { settings: !parsed.values['no-settings'], removeOthers: parsed.values['remove-others'] }, parsed.values['dry-run'], context, dependencies, parsed.values.verbose)
}

/**
 * Write the profile's setup as a signed archive.
 * @param ctx - the profile.
 * @param out - the archive file to create.
 * @param choices - what to carry.
 * @param context - the output.
 * @param dependencies - the profile lock.
 * @returns the exit code.
 * @throws {CliError} when the setup holds a key, the file exists or a plugin is too large to carry.
 */
async function runExport(ctx: ChangesContext, out: string, choices: CollectOptions, context: CommandContext, dependencies: ChangesCommandDependencies, verbose: boolean): Promise<CommandResult> {
  try {
    const collected = await dependencies.withHost(ctx.home, ctx.profile, async () => collectSetup(ctx, choices))
    const key = (await loadHomeKey(ctx.home, { create: true }))!
    const bytes = exportSetupArchive({
      createdBy: String(delorunVersion()),
      origin: { homeKeyId: key.keyId, publicKey: key.publicKey },
      document: collected.document,
      files: collected.files,
      sign: manifest => signManifest(manifest, key.keyId, key.privateKey),
    })
    await writeNewFile(out, bytes, 'delorun setup export')
    const local = collected.document.plugins.filter(plugin => plugin.source === 'local').length
    const withoutCode = collected.document.plugins.filter(plugin => plugin.source === 'local' && plugin.files.length === 0).map(plugin => plugin.name)
    context.stdout(`Wrote ${quoted(out)}: ${plural(collected.document.plugins.length, 'plugin')} (${String(local)} made on this computer${withoutCode.length === 0 ? ', carried with their files' : ''}), ${String(collected.document.models.length)} model ${collected.document.models.length === 1 ? 'entry' : 'entries'}${collected.document.includesSettings ? ` and ${String(collected.document.settings.length)} other settings` : ', no other settings'}.\n`)
    context.stdout(`Signed by this home's key, fingerprint ${groupsOfFour(keyFingerprint(key.publicKey))}\n  The other computer asks you to compare it.\n`)
    for (const line of leftOutLines(collected.leftOut, 'Left out of the file', verbose)) context.stdout(`${line}\n`)
    if (withoutCode.length > 0) context.stdout(`Named without their code, to copy yourself: ${withoutCode.join(', ')}\n`)
    context.stdout('The file holds no key, chat, device or setup answer. Import it on the other computer with: delorun setup import <file>\n')
    return EXIT.ok
  } catch (error: unknown) {
    if (isChangesError(error)) throw new CliError(EXIT.failed, `delorun setup export: ${error.detail}`)
    if (error instanceof ArchiveError) throw new CliError(EXIT.failed, `delorun setup export: ${error.message}`)
    throw error
  }
}

/**
 * Show a setup archive, ask, and replace the profile's setup with it.
 * @param ctx - the profile.
 * @param file - the archive.
 * @param choices - what the person chose.
 * @param dryRun - whether to show and stop.
 * @param context - the output.
 * @param dependencies - the terminal, the profile lock and the plugin operation.
 * @returns the exit code.
 * @throws {CliError} for a refused archive, a refused setup, a declined question or a failed step.
 */
async function runImport(ctx: ChangesContext, file: string, choices: ImportOptions, dryRun: boolean, context: CommandContext, dependencies: ChangesCommandDependencies, verbose: boolean): Promise<CommandResult> {
  const presence = dryRun ? undefined : attestAtTerminal(dependencies)
  const bytes = await readArchiveFile(file, 'delorun setup import')
  try {
    const opened = await openArchive(ctx.home, bytes, file)
    const { plan } = await planSetupImport(ctx, opened.document, choices)
    context.stdout(importLines(opened, plan, ctx.profile, await readProtection(ctx.home), verbose))
    if (dryRun) {
      context.stdout('Dry run: nothing was changed.\n')
      return EXIT.ok
    }
    if (!plan.changes) {
      context.stdout('This profile already has this setup. Nothing to do.\n')
      return EXIT.ok
    }
    const answer = await dependencies.ask(`Replace the setup of the profile ${ctx.profile} with this one? [y/N] `)
    if (!isYes(answer)) throw new CliError(EXIT.failed, 'delorun setup import: nothing was changed')
    for (const { provider, host } of plan.endpointNotices) {
      const allowed = await dependencies.ask(`Requests and your ${printable(provider)} key will go to ${printable(host)}. Allow that? [y/N] `)
      if (!isYes(allowed)) throw new CliError(EXIT.failed, 'delorun setup import: nothing was changed')
    }
    const result = await dependencies.withHost(ctx.home, ctx.profile, reload => applySetupImport(ctx, opened.document, {
      presence: presence!,
      choices: { ...choices, endpointsConfirmed: true },
      reload,
      run: dependencies.pluginOperation(ctx, context),
      readFile: opened.readFile,
      progress: line => context.stdout(`${line}\n`),
    }))
    context.stdout(afterLines(result.savedVersion, result.installed.flatMap(item => item.reviewChange === undefined ? [] : [item.reviewChange]), plan, await readProtection(ctx.home)))
    return EXIT.ok
  } catch (error: unknown) {
    if (error instanceof ArchiveError) throw new CliError(EXIT.failed, `delorun setup import: the archive is refused (${error.code}): ${quoted(error.message)}; nothing was changed`)
    if (isChangesError(error)) throw new CliError(EXIT.failed, `delorun setup import: ${error.detail}`)
    throw error
  }
}

/**
 * @param dependencies - the streams whose being terminals proves the person is at their computer.
 * @returns the proof.
 * @throws {CliError} when standard input or output is not a terminal.
 */
function attestAtTerminal(dependencies: ChangesCommandDependencies): AtComputer {
  try {
    return attestTerminal(dependencies.streams)
  } catch (error: unknown) {
    if (!isChangesError(error)) throw error
    throw new CliError(EXIT.failed, 'delorun setup import: This needs you at your computer: run it in a terminal. delorun setup import --dry-run shows what a file holds without one.')
  }
}

/**
 * Validate a setup archive with this home's own key vouched for.
 * @param home - the Delorun home.
 * @param bytes - the archive.
 * @param source - the file's name.
 * @returns the opened setup.
 * @throws {ArchiveError} with the code of the first refusal.
 */
async function openArchive(home: string, bytes: Uint8Array, source: string): Promise<OpenedSetup> {
  const ownKey = await loadHomeKey(home)
  const root = join(home, 'archive')
  const importer = new ArchiveImporter({
    stagingParent: join(root, 'staging'),
    store: new DirectoryWorkspaceStore(join(root, 'imported')),
    trustedPublicKeys: ownKey === undefined ? [] : [ownKey.publicKey],
    limits: IMPORT_LIMITS,
  })
  return importer.openSetup(bytes, { source })
}

/**
 * What the person reads before the question: who signed the archive, what it states about itself, and every change.
 * @param opened - the opened archive.
 * @param plan - the plan.
 * @param profile - the profile it would replace the setup of.
 * @param protection - the Changes protection setting.
 * @param verbose - whether to list every setting a setup does not carry instead of counting them.
 * @returns the text.
 */
export function importLines(opened: OpenedSetup, plan: SetupPlan, profile: string, protection: 'on' | 'off', verbose = false): string {
  const signer = opened.state === 'verified'
    ? `Signed by this home's key ${groupsOfFour(opened.signer.fingerprint)}, which this home trusts.`
    : opened.reason === 'absent'
      ? '! Unsigned: this file is not signed, so nothing shows who made it or that it is unchanged.'
      : `! Unverified signer · ${groupsOfFour(opened.signer.fingerprint)}\n  Compare it with the fingerprint the other computer printed.`
  const lines = [
    signer,
    'What the archive states about itself:',
    `  File ${quoted(opened.source)}, written by ${quoted(opened.createdBy)} at ${quoted(opened.exportedAt)} from the profile ${quoted(opened.document.profile)}.`,
    ...opened.document.note === undefined ? [] : [`  Note from the sender: ${quoted(opened.document.note)}`],
    '',
    `Importing it replaces these parts of your profile ${profile}: ${plan.replaces.join('; ')}. Your keys, chats, devices, exemptions and setup answers are not touched.`,
  ]
  const adds = plan.install.map((item) => {
    const where = item.plugin.source === 'local' ? 'made on another computer; its code waits for your review' : 'from the registry'
    const was = item.from === undefined ? '' : ` (now: ${printable(item.from)})`
    return `    ${item.kind === 'add' ? '+' : '~'} ${item.plugin.name}${item.plugin.version === undefined ? '' : ` ${item.plugin.version}`}, ${where}${was}`
  })
  lines.push('Plugins:', ...adds.length === 0 ? ['    none to add or move'] : adds)
  if (plan.named.length > 0) lines.push(`  Named without their code, which you copy yourself: ${plan.named.map(printable).join(', ')}`)
  if (plan.remove.length > 0) lines.push('  Removed, because the archive does not list them:', ...plan.remove.map(name => `    - ${printable(name)}`))
  if (plan.keep.length > 0) lines.push(`  Already as the archive names them: ${plan.keep.map(printable).join(', ')}`)
  lines.push('Model choices and settings:', ...plan.settings.length === 0 ? ['    no change'] : plan.settings.map(line => `    ${printable(line)}`))
  if (plan.endpoints.length > 0) lines.push('  Endpoints these settings send requests to:', ...plan.endpoints.map(line => `    ${printable(line)}`))
  if (plan.endpointNotices.length > 0) lines.push('  Requests and keys go to endpoints that are not the provider\'s default; you are asked about each before anything changes:', ...plan.endpointNotices.map(({ provider, host }) => `    Requests and your ${printable(provider)} key will go to ${printable(host)}`))
  lines.push(...leftOutLines(plan.leftOut, 'Not applied, because a setup does not carry them', verbose))
  lines.push(protection === 'on'
    ? 'Protection is on: the code of a plugin from this file waits in delorun changes list until you review it.'
    : 'Protection is off: the code of a plugin from this file loads at the next start without review. delorun changes protection on makes it wait for you first.')
  return `${lines.join('\n')}\n`
}

/**
 * What the person reads once the import is done: how to undo it, what waits for review and the key.
 * @param saved - the history version saved before the import.
 * @param reviews - the changes that hold a local plugin's code.
 * @param plan - the plan that was applied.
 * @param protection - the Changes protection setting.
 * @returns the text.
 */
export function afterLines(saved: string, reviews: readonly string[], plan: SetupPlan, protection: 'on' | 'off'): string {
  const lines = ['Done.', `To go back to the setup you had: delorun recover restore ${saved}, or Settings → Setup versions in the studio ("Before importing a setup").`]
  if (reviews.length > 0) {
    lines.push(protection === 'on'
      ? `Code waiting for your review: ${reviews.map(id => `delorun changes show ${id}`).join(', ')}`
      : 'Protection is off, so the code of the plugins made on another computer loads at the next start; delorun changes list shows what it loaded.')
  }
  lines.push(...plan.keyNotes)
  return `${lines.join('\n')}\n`
}
