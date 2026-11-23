/**
 * Setup's `import` section (contract C11): "Copy your N DeepSeek Harness chats?",
 * asked only when the stock home is a directory (not a link to one) and the
 * Delorun home holds no chat yet. Setup copies the data alone: the chats, the
 * attachments and the workspace list. Profiles, settings, instructions, skills and
 * stored keys can change what Delorun runs or what the agent is told, so only
 * `delorun import-home` copies them, each after its own yes. The question shows a
 * summary of what copies and what stays behind, offers Yes, Later and the full
 * list, and writes the full list to `import-preview.txt` in the Delorun home. The
 * write carries out exactly the plan the summary was made from, under the home
 * lock of every profile; a stock file that changed since stops it.
 *
 * @module @delorun/cli/import-home/section
 */
import { chmodSync, lstatSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DELORUN_HOME_FILES } from '@delorun/contract-home-layout'
import { applyDshHomeImport, isDshImportError, planDshHomeImport, recoverDshImport, type DshHomeImportPlan } from '@delorun/archive/dsh-import'
import { CliError, EXIT } from '../exit.ts'
import { withHomeExclusive } from '../home-exclusion.ts'
import { printable } from '../terminal-text.ts'
import { BACK } from '../setup/steps.ts'
import type { SetupSection } from '../setup/sections.ts'
import { personHomeOption, stockHomeOf } from './index.ts'
import { counted, previewText, reportText } from './preview.ts'

/** The section's id, `delorun setup import`. */
export const IMPORT_SECTION_ID = 'import'

/** What the section runs with. */
export interface ImportSectionOptions {
  /** The bundles Delorun appends to every carried profile. */
  readonly delorunBundles: readonly string[]
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
 * Whether the Delorun home holds a chat.
 * @param home - the Delorun home.
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

/** The file in the Delorun home that holds the full preview text. */
export const IMPORT_PREVIEW_FILE = DELORUN_HOME_FILES.importPreview

/**
 * The summary the question shows.
 * @param plan - the plan.
 * @returns the chats, attachments and workspaces that copy, what stays behind, and the line that says the stock home is only read.
 */
export function importSummary(plan: DshHomeImportPlan): string[] {
  const chats = plan.chats.filter(chat => chat.state === 'new').length
  const unfinished = plan.skippedTotals['unfinished-turn'] ?? 0
  const other = Object.entries(plan.skippedTotals).reduce((sum, [reason, count]) => reason === 'unfinished-turn' ? sum : sum + count, 0)
  const behind = [
    ...unfinished === 0 ? [] : [`${counted(unfinished, 'unfinished chat')}`],
    ...other === 0 ? [] : [`${String(other)} locks, caches and packages`],
  ]
  return [
    `Will copy:    ${counted(chats, 'chat')} · ${counted(plan.attachments.length, 'attachment')} · ${counted(plan.registry?.workspaces ?? 0, 'workspace')}`,
    `Stays behind: ${behind.length === 0 ? 'nothing' : behind.join(' · ')}`,
    'Your DeepSeek Harness folder is only read.',
  ]
}

/**
 * Write the full preview where the person can read it later.
 * @param home - the Delorun home.
 * @param text - the preview text.
 * @returns the file's path.
 */
function writePreviewFile(home: string, text: string): string {
  const path = join(home, IMPORT_PREVIEW_FILE)
  writeFileSync(path, text, { mode: 0o600 })
  // A file left by an earlier run keeps its old mode under writeFileSync.
  chmodSync(path, 0o600)
  return path
}

/**
 * The import section.
 * @param options - Delorun's bundles and the exclusion.
 * @returns the section, which the registry places between the privacy note and the key.
 */
export function importSection(options: ImportSectionOptions): SetupSection {
  const exclusive = options.exclusive ?? ((home: string, profile: string, run) => withHomeExclusive({ home, profile, command: 'setup', instead: '' }, run))
  // The plan the person saw, which the write carries out; a resumed run that did not show one imports nothing.
  let shown: DshHomeImportPlan | undefined
  return {
    id: IMPORT_SECTION_ID,
    title: 'Import a DeepSeek Harness home',
    inMainFlow: 'asked',
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
        planned = await planDshHomeImport({ sourceHome: source, targetHome: environment.home, delorunBundles: options.delorunBundles, reservedProfiles: [environment.profile], ...personHomeOption(environment.env) })
      } catch (error: unknown) {
        if (!isDshImportError(error)) throw error
        io.note(`Your DeepSeek Harness home cannot be imported (${error.code}): ${printable(error.message)}\nRun delorun import-home later to see why and to try again.`, 'Import')
        return { answers: { importStockHome: false }, status: 'seen' }
      }
      const full = previewText(planned, PREVIEW)
      if (planned.blockers.length > 0) {
        io.note(full.trimEnd(), 'Your DeepSeek Harness home')
        io.note(planned.blockers.map(blocker => printable(blocker.message)).join('\n'), 'Import')
        return { answers: { importStockHome: false }, status: 'seen' }
      }
      const written = writePreviewFile(environment.home, full)
      io.note([...importSummary(planned), `Full list: ${written}`].join('\n'), 'Your DeepSeek Harness home')
      const question = `Copy your ${counted(planned.chats.filter(chat => chat.state === 'new').length, 'DeepSeek Harness chat', 'DeepSeek Harness chats')}?`
      for (;;) {
        const answer = await io.select(question, [
          { value: 'yes', label: 'Yes' },
          { value: 'later', label: 'Later (delorun import-home)' },
          { value: 'show', label: 'Show what stays behind' },
        ], 'yes')
        if (answer === BACK) return BACK
        if (answer === 'show') {
          io.note(full.trimEnd(), 'Everything the import covers')
          continue
        }
        if (answer === 'yes') shown = planned
        return { answers: { importStockHome: answer === 'yes' }, status: 'answered' }
      }
    },
    async apply(context, answers) {
      if (!answers.importStockHome) return undefined
      const planned = shown
      if (planned === undefined) throw new CliError(EXIT.failed, 'delorun setup: the DeepSeek Harness home was not imported, because this run did not show what it copies; run delorun import-home')
      try {
        return await exclusive(context.home, basename(context.directory), async () => {
          await recoverDshImport(context.home)
          // The plan was shown before the lock was held; a chat the Delorun home gained since would make this a merge nobody asked for.
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
