/**
 * `delorun import-home [--from <dir>] [--dry-run] [--merge] [--max-size <bytes>]`
 * (contract C8, "The stock-home import"): copy a stock DeepSeek Harness home
 * into the Delorun home. The stock home is hostile input and is only ever read.
 *
 * The command shows the whole preview first: the chats, attachments and
 * workspace registrations, then each category that can change what Delorun runs
 * or what the agent is told: the profiles with every bundle and plugin, the
 * settings layers with each row that lands and each row held back, the
 * instructions, the skills and the stored keys by name; and what stays behind
 * with the reason. `--dry-run` stops there and writes nothing, not even the
 * home's own directories. Otherwise the command holds the home lock of every
 * profile, withdraws an import a crash interrupted, plans again under the
 * lock, shows the preview, and asks about the data; then it asks about each
 * category that holds something, one by one, after showing the whole text
 * that lands a screenful at a time, and every answer but yes leaves that
 * category out. A skill's own instructions are shown when the person asks. Without a terminal
 * nothing is asked, so nothing is imported. A Delorun home that already holds
 * chats is refused unless `--merge` is given, and a chat whose identifier the
 * Delorun home holds with other content is refused, never overwritten. No plugin
 * is installed and nothing the stock home holds is run.
 *
 * @module @delorun/cli/import-home
 */
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { join } from 'node:path'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { applyDshHomeImport, DSH_IMPORT_CATEGORIES, isDshImportError, planDshHomeImport, recoverDshImport, resolveDshImportLimits, type DshHomeImportPlan, type DshImportCategory } from '@delorun/archive/dsh-import'
import { UPSTREAM_HOME_DIR_NAME } from '@delorun/contract-home-layout'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { parseFailure } from '../command.ts'
import { printable, quoted } from '../terminal-text.ts'
import { isYes } from '../trash/terminal.ts'
import { categoryOffered, categoryQuestion, categoryText, counted, previewText, reportText, skillInstructionLines } from './preview.ts'

/** The usage line. */
export const IMPORT_HOME_USAGE = 'Usage: delorun import-home [--from <dir>] [--dry-run] [--merge] [--max-size <bytes>] [--profile <name>]'

/** What `delorun import-home` runs with. */
export interface ImportHomeIo {
  /** The Delorun home. */
  readonly home: string
  /** The CLI profile, which a stock profile of the same name never takes. */
  readonly profile: string
  /** The environment, whose home directory locates the default stock home. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The bundles Delorun appends to every carried profile. */
  readonly delorunBundles: readonly string[]
  /** Write to standard output. */
  readonly stdout: (text: string) => void
  /** Ask one question; the empty string when no terminal can ask. */
  readonly ask: (question: string) => Promise<string>
  /** Run the import while this process holds every profile's home lock; refuses while a home process runs. */
  readonly exclusive: <T>(run: () => Promise<T>) => Promise<T>
}

/**
 * The stock home a person's environment names: `.dsh` in their home directory.
 * @param env - the environment.
 * @returns the path, or `undefined` when the environment names no home directory.
 */
export function stockHomeOf(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const home = personHomeOf(env)
  return home === undefined ? undefined : join(home, UPSTREAM_HOME_DIR_NAME)
}

/**
 * The person's home directory, which no imported workspace or chat may stand in.
 * @param env - the environment.
 * @returns `HOME`, else `USERPROFILE`, or `undefined` when neither names a directory.
 */
export function personHomeOf(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const home = env['HOME'] ?? env['USERPROFILE']
  return home === undefined || home.trim() === '' ? undefined : home
}

/**
 * The plan option that names the person's home directory.
 * @param env - the environment.
 * @returns `{ personHome }`, or nothing when the environment names no home directory.
 */
export function personHomeOption(env: Readonly<Record<string, string | undefined>>): { readonly personHome?: string } {
  const home = personHomeOf(env)
  return home === undefined ? {} : { personHome: home }
}

/** The lines a pager shows before it asks to go on. */
export const PAGE_LINES = 40

/** The question between two screenfuls. */
export const MORE_QUESTION = '-- more (Enter to go on, q to stop reading) -- '

/**
 * Show lines a screenful at a time.
 * @param lines - the lines, each already escaped.
 * @param io - the output and the question.
 * @returns true when the person read to the end, false when they stopped, after saying the rest was not shown.
 */
export async function page(lines: readonly string[], io: Pick<ImportHomeIo, 'stdout' | 'ask'>): Promise<boolean> {
  for (let start = 0; start < lines.length; start += PAGE_LINES) {
    io.stdout(`${lines.slice(start, start + PAGE_LINES).join('\n')}\n`)
    if (start + PAGE_LINES >= lines.length) break
    if ((await io.ask(MORE_QUESTION)).trim().toLowerCase() === 'q') {
      io.stdout(`The rest was not shown (${counted(lines.length - start - PAGE_LINES, 'more line')}); the answer below starts on no.\n`)
      return false
    }
  }
  return true
}

/** The sentence after the credential names in this command's preview. */
const CREDENTIALS_SENTENCE = 'copied only if you say yes to them; their values are never shown'

/** What this command's preview covers. */
const PREVIEW = { credentials: CREDENTIALS_SENTENCE, categories: true } as const

/**
 * Run `delorun import-home`.
 * @param args - the arguments after `import-home`, without `--profile`.
 * @param io - the home, the profile, the environment, the output, the question and the exclusion.
 * @returns the exit code.
 * @throws {CliError} for a wrong command line, a refused import, or an import the person did not confirm.
 */
export async function runImportHome(args: readonly string[], io: ImportHomeIo): Promise<ExitCode> {
  let values
  try {
    values = parseArgs({ args: [...args], options: { from: { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, merge: { type: 'boolean', default: false }, 'max-size': { type: 'string' } }, strict: true, allowPositionals: false }).values
  } catch (error: unknown) {
    throw parseFailure('import-home', error)
  }
  const source = values.from === undefined ? stockHomeOf(io.env) : expandHomePath(values.from)
  if (source === undefined) throw new CliError(EXIT.usage, `delorun import-home: no home directory is set, so give the DeepSeek Harness home with --from\n${IMPORT_HOME_USAGE}`)
  const maxSize = values['max-size']
  if (maxSize !== undefined && !(/^[1-9]\d{0,15}$/u.test(maxSize) && Number.isSafeInteger(Number(maxSize)))) {
    throw new CliError(EXIT.usage, `delorun import-home: --max-size takes a whole number of bytes, such as 8589934592 for 8 GiB\n${IMPORT_HOME_USAGE}`)
  }
  if (!existsSync(source)) {
    throw new CliError(EXIT.failed, `delorun import-home: there is no DeepSeek Harness folder at ${source}, so there is nothing to copy. If yours is somewhere else, run delorun import-home --from <folder>.`)
  }
  const plan = (): Promise<DshHomeImportPlan> => planDshHomeImport({
    sourceHome: source,
    targetHome: io.home,
    merge: values.merge,
    limits: resolveDshImportLimits(maxSize === undefined ? undefined : Number(maxSize)),
    delorunBundles: io.delorunBundles,
    reservedProfiles: [io.profile],
    ...personHomeOption(io.env),
  })
  return refusing(async () => {
    if (values['dry-run']) {
      const planned = await plan()
      io.stdout(previewText(planned, PREVIEW))
      refuseBlocked(planned)
      io.stdout('Dry run: nothing was written.\n')
      return EXIT.ok
    }
    return io.exclusive(async () => {
      const recovered = await recoverDshImport(io.home)
      if (recovered.withdrawn.length > 0) io.stdout(`Withdrew an import that was interrupted: ${counted(recovered.withdrawn.length, 'file')} it had placed.\n`)
      if (recovered.kept.length > 0) io.stdout(`Left in place because Delorun wrote to them since: ${recovered.kept.map(quoted).join(', ')}.\n`)
      const planned = await plan()
      io.stdout(previewText(planned, PREVIEW))
      refuseBlocked(planned)
      if (!isYes(await io.ask('Copy your chats, attachments and workspace list into the Delorun home? [y/N] '))) throw new CliError(EXIT.failed, 'delorun import-home: nothing was imported')
      const include: Partial<Record<DshImportCategory, boolean>> = {}
      for (const category of DSH_IMPORT_CATEGORIES) {
        if (!categoryOffered(planned, category)) continue
        await page(categoryText(planned, category), io)
        if (category === 'skills') {
          for (const skill of planned.skills) {
            if (isYes(await io.ask(`Show the instructions of the skill ${quoted(skill.path.slice('skills/'.length))}? [y/N] `))) await page(skillInstructionLines(skill), io)
          }
        }
        include[category] = isYes(await io.ask(categoryQuestion(planned, category)))
      }
      const report = await applyDshHomeImport(planned, { include })
      io.stdout(reportText(report, planned))
      return EXIT.ok
    })
  })
}

/**
 * Refuse a plan that cannot go on, naming every reason.
 * @param plan - the plan.
 * @throws {CliError} when the plan has a blocker.
 */
function refuseBlocked(plan: DshHomeImportPlan): void {
  if (plan.blockers.length === 0) return
  throw new CliError(EXIT.failed, [
    'delorun import-home: the import cannot go on, so nothing was imported:',
    ...plan.blockers.map(blocker => `  ${blocker.code}: ${printable(blocker.message)}`),
  ].join('\n'))
}

/**
 * Run the command and turn an import refusal into the command's failure.
 * @param run - the command's work.
 * @returns its exit code.
 * @throws {CliError} for a refusal, with its code and message, and every other failure unchanged.
 */
async function refusing(run: () => Promise<ExitCode>): Promise<ExitCode> {
  try {
    return await run()
  } catch (error: unknown) {
    if (!isDshImportError(error)) throw error
    throw new CliError(EXIT.failed, `delorun import-home: the import is refused (${error.code}): ${printable(error.message)}; nothing was imported`)
  }
}
