/**
 * Setup's `import` section (contract C11): "Copy your DeepSeek Harness chats?",
 * asked in Quick and Full setup only when the stock home is a directory (not a
 * link to one) and the Delo home holds no chat yet. Setup copies the data
 * alone: the chats, the attachments and the workspace list. Profiles,
 * settings, instructions, skills and stored keys can change what Delo runs or
 * what the agent is told, so only `delorun import-home` copies them, each after
 * its own yes. The question shows the preview first and defaults to no, and
 * the write carries out exactly the plan that preview showed, under the home
 * lock of every profile; a stock file that changed since stops it.
 *
 * @module @delo/cli/import-home/section
 */
import { lstatSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { applyDshHomeImport, isDshImportError, planDshHomeImport, recoverDshImport, type DshHomeImportPlan } from '@delo/archive/dsh-import'
import { CliError, EXIT } from '../exit.ts'
import { withHomeExclusive } from '../home-exclusion.ts'
import { printable } from '../terminal-text.ts'
import { BACK } from '../setup/steps.ts'
import type { SetupSection } from '../setup/sections.ts'
import { personHomeOption, stockHomeOf } from './index.ts'
import { previewText, reportText } from './preview.ts'

/** The section's id, `delorun setup import`. */
export const IMPORT_SECTION_ID = 'import'

/** What the section runs with. */
export interface ImportSectionOptions {
  /** The bundles Delorun appends to every carried profile. */
  readonly deloBundles: readonly string[]
  /** Runs the import while this process holds every profile's home lock; {@link withHomeExclusive} by default. */
  readonly exclusive?: <T>(home: string, profile: string, run: () => Promise<T>) => Promise<T>
}

/**
 * Whether a directory exists at a path, without following a link there.
 * @param path - the path.
 * @returns true for a directory; false for a link, whatever it points to.
 */
function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    // ENOENT or EACCES: there is no stock home this run can read.
    return false
  }
}

/**
 * Whether the Delo home holds a chat.
 * @param home - the Delo home.
 * @returns true when its sessions root holds a Session directory.
 */
export function homeHasChats(home: string): boolean {
  try {
    return readdirSync(join(home, 'sessions'), { withFileTypes: true }).some(project =>
      project.isDirectory() && readdirSync(join(home, 'sessions', project.name), { withFileTypes: true }).some(session => session.isDirectory()))
  } catch {
    // ENOENT: a new home has no sessions root yet.
    return false
  }
}

/** What setup's preview covers: the data alone. */
const PREVIEW = { credentials: 'setup does not copy them', categories: false } as const

/**
 * The import section.
 * @param options - Delo's bundles and the exclusion.
 * @returns the section, which the registry places between the privacy note and the key.
 */
export function importSection(options: ImportSectionOptions): SetupSection {
  const exclusive = options.exclusive ?? ((home: string, profile: string, run) => withHomeExclusive({ home, profile, command: 'setup', instead: '' }, run))
  // The plan the person saw, which the write carries out; a resumed run that did not show one imports nothing.
  let shown: DshHomeImportPlan | undefined
  return {
    id: IMPORT_SECTION_ID,
    title: 'Import a DeepSeek Harness home',
    plan: { local: 'asked', remote: 'asked', automation: 'never' },
    asks: () => true,
    appliesTo(environment) {
      const source = stockHomeOf(environment.env)
      return source !== undefined && isDirectory(source) && !homeHasChats(environment.home)
    },
    async ask(io, _draft, environment) {
      const source = stockHomeOf(environment.env) as string
      shown = undefined
      let planned: DshHomeImportPlan
      try {
        planned = await planDshHomeImport({ sourceHome: source, targetHome: environment.home, deloBundles: options.deloBundles, reservedProfiles: [environment.profile], ...personHomeOption(environment.env) })
      } catch (error: unknown) {
        if (!isDshImportError(error)) throw error
        io.note(`Your DeepSeek Harness home cannot be imported (${error.code}): ${printable(error.message)}\nRun delorun import-home later to see why and to try again.`, 'Import')
        return { answers: { importStockHome: false }, status: 'seen' }
      }
      io.note(previewText(planned, PREVIEW).trimEnd(), 'Your DeepSeek Harness home')
      if (planned.blockers.length > 0) {
        io.note(planned.blockers.map(blocker => printable(blocker.message)).join('\n'), 'Import')
        return { answers: { importStockHome: false }, status: 'seen' }
      }
      const answer = await io.confirm('Copy your DeepSeek Harness chats, attachments and workspace list? Your DeepSeek Harness folder is only read. You can also do this later with delorun import-home.', false)
      if (answer === BACK) return BACK
      if (answer) shown = planned
      return { answers: { importStockHome: answer }, status: 'answered' }
    },
    review: answers => `Copy your DeepSeek Harness chats: ${answers.importStockHome ? 'yes' : 'no'}`,
    async apply(context, answers) {
      if (!answers.importStockHome) return undefined
      const planned = shown
      if (planned === undefined) throw new CliError(EXIT.failed, 'delorun setup: the DeepSeek Harness home was not imported, because this run did not show what it copies; run delorun import-home')
      try {
        return await exclusive(context.home, basename(context.directory), async () => {
          await recoverDshImport(context.home)
          // The plan was shown before the lock was held; a chat the Delo home gained since would make this a merge nobody asked for.
          if (homeHasChats(context.home)) throw new CliError(EXIT.failed, 'delorun setup: the DeepSeek Harness home was not imported, because the Delorun home gained chats after the preview; run delorun import-home --merge to add them beside those')
          return reportText(await applyDshHomeImport(planned, { include: {} }), planned).trimEnd()
        })
      } catch (error: unknown) {
        if (!isDshImportError(error)) throw error
        throw new CliError(EXIT.failed, `delorun setup: the DeepSeek Harness home was not imported (${error.code}): ${printable(error.message)}; run delorun import-home to try again`)
      }
    },
  }
}
