/**
 * The data-safety suite: what a person waits for when they save or move their chats. In a home with the small or the
 * large synthetic chat set, with Delo stopped, `delorun export` writes one chat and then the home's workspace with
 * every chat, and `delorun import` reads the workspace archive back after the person answers yes. A pseudo-terminal
 * from `script` answers the import's question, because the import asks only on a terminal. With Delo running, the
 * studio's own trash routes move a chat to the trash and restore it, and, once every chat is in the trash, list it;
 * with Delo stopped again `delorun trash list` lists the large trash.
 *
 * @module @delo/benchmarks/suites/data
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chatIds } from '../../fixtures/data.ts'
import { copyHome, delorun, deloRequest, stopHome, type InstalledHome } from '../../fixtures/home.ts'
import { installedChannel, templateHome } from '../../fixtures/releases.ts'
import { expectSuccess, run, type Finished } from '../../harness/processes.ts'
import { Samples, type ScenarioResult, type Skipped, type SuiteResult } from '../../harness/result.ts'
import type { BenchRoot } from '../../harness/roots.ts'
import type { Suite, SuiteContext } from '../../harness/suite.ts'
import { studioLink } from '../start/index.ts'

/** The suite's items. */
export const DATA_ITEMS: Readonly<Record<string, string>> = {
  'export-chat': '`delorun export <chat> --out <file>` of one chat, from start to exit',
  'export-workspace': '`delorun export <workspace> --out <file>` of the workspace holding every chat, from start to exit',
  'import-workspace': '`delorun import <file>` of that archive with the question answered yes, from start to exit',
  'trash-delete-chat': 'The studio moving one chat to the trash, from the request to the answer',
  'trash-restore-chat': 'The studio restoring that chat, from the request to the answer',
  'trash-delete-all': 'The studio moving every chat to the trash, one request each, from the first request to the last answer',
  'trash-list-full': 'The studio listing the trash that holds every chat, from the request to the answer',
  'trash-list-cli': '`delorun trash list` of the trash that holds every chat, with Delo stopped, from start to exit',
}

/** The workspace registry's document, as far as this suite reads and extends it. */
interface WorkspaceDocument {
  readonly tables?: { readonly workspaces?: Record<string, { readonly sessionIds?: string[] }> }
}

/**
 * Put every synthetic chat into the home's first workspace, so exporting it carries them all.
 * @param deloHome - the Delo home.
 * @param chats - the synthetic chats' ids.
 * @returns the workspace's id, or `undefined` when the home has no workspace registry or no workspace.
 */
export function gatherIntoWorkspace(deloHome: string, chats: readonly string[]): string | undefined {
  const path = join(deloHome, 'storages', 'workspace.json')
  if (!existsSync(path)) return undefined
  const document = JSON.parse(readFileSync(path, 'utf8')) as WorkspaceDocument
  const [id, workspace] = Object.entries(document.tables?.workspaces ?? {})[0] ?? []
  if (id === undefined || workspace === undefined) return undefined
  const ids = new Set(workspace.sessionIds ?? [])
  for (const chat of chats) ids.add(chat)
  const gathered = { ...document, tables: { ...document.tables, workspaces: { ...document.tables!.workspaces, [id]: { ...workspace, sessionIds: [...ids] } } } }
  writeFileSync(path, `${JSON.stringify(gathered, undefined, 2)}\n`)
  return id
}

/**
 * A shell word: the text in single quotes.
 * @param text - the text.
 * @returns the quoted word.
 */
export function shellWord(text: string): string {
  return `'${text.split('\'').join('\'\\\'\'')}'`
}

/**
 * Run a `delorun` command on a pseudo-terminal that `script` provides, typing the input.
 * @param home - the home.
 * @param args - the arguments.
 * @param input - what the person types.
 * @returns how it finished.
 */
async function onTerminal(home: InstalledHome, args: readonly string[], input: string): Promise<Finished> {
  const request = deloRequest(home, args, 600_000)
  const commandLine = [request.command, ...request.args].map(shellWord).join(' ')
  return run({ ...request, command: 'script', args: ['-q', '-e', '-c', commandLine, '/dev/null'], input })
}

/** The studio's owner session: its origin and cookie. */
interface Studio {
  readonly origin: string
  readonly cookie: string
}

/**
 * Open the studio as its owner through the start link.
 * @param deloHome - the Delo home.
 * @param since - the start's time.
 * @returns the origin and the cookie.
 * @throws {Error} when the link is missing or refused.
 */
async function openStudio(deloHome: string, since: number): Promise<Studio> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const link = studioLink(deloHome, since)
    if (link !== undefined) {
      const opened = await fetch(link, { redirect: 'manual' })
      const cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0]!
      if (cookie !== '') return { origin: new URL(link).origin, cookie }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('the studio printed no start link that gave a cookie')
}

/**
 * Call one trash route as the studio does, and time it.
 * @param studio - the owner session.
 * @param path - the route.
 * @param body - the request body.
 * @returns the answer and the milliseconds it took.
 * @throws {Error} when the route refuses.
 */
async function trashRoute(studio: Studio, path: string, body: Readonly<Record<string, unknown>>): Promise<{ readonly answer: unknown, readonly ms: number }> {
  const started = Date.now()
  const response = await fetch(`${studio.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: studio.cookie, origin: studio.origin }, body: JSON.stringify(body) })
  const answer: unknown = await response.json()
  if (!response.ok) throw new Error(`${path} answered ${String(response.status)}: ${JSON.stringify(answer)}`)
  return { answer, ms: Date.now() - started }
}

/**
 * One repetition's items.
 * @param home - the home, copied from the template.
 * @param chats - the synthetic chats' ids.
 * @param workspace - the workspace that holds them, if the home has one.
 * @returns the items.
 */
async function repetition(home: InstalledHome, chats: readonly string[], workspace: string | undefined): Promise<Record<string, number>> {
  const items: Record<string, number> = {}
  const out = (name: string): string => join(home.root.path, name)
  const exportChat = expectSuccess(await delorun(home, ['export', chats[0]!, '--out', out('chat.delo')], 600_000), '`delorun export` of a chat')
  items['export-chat'] = exportChat.endedAt - exportChat.startedAt
  if (workspace !== undefined) {
    const exportWorkspace = expectSuccess(await delorun(home, ['export', workspace, '--out', out('workspace.delo')], 600_000), '`delorun export` of the workspace')
    items['export-workspace'] = exportWorkspace.endedAt - exportWorkspace.startedAt
    const imported = expectSuccess(await onTerminal(home, ['import', out('workspace.delo')], 'y\n'), '`delorun import`')
    items['import-workspace'] = imported.endedAt - imported.startedAt
  }
  const start = expectSuccess(await delorun(home, ['start'], 300_000), '`delorun start`')
  const studio = await openStudio(home.root.deloHome, start.startedAt)
  const deleted = await trashRoute(studio, '/api/deloTrash.deleteChat', { sessionId: chats[0] })
  items['trash-delete-chat'] = deleted.ms
  const restored = await trashRoute(studio, '/api/deloTrash.restore', { itemId: (deleted.answer as { readonly id: string }).id })
  items['trash-restore-chat'] = restored.ms
  const allStarted = Date.now()
  for (const chat of chats) await trashRoute(studio, '/api/deloTrash.deleteChat', { sessionId: chat })
  items['trash-delete-all'] = Date.now() - allStarted
  items['trash-list-full'] = (await trashRoute(studio, '/api/deloTrash.list', {})).ms
  await stopHome(home)
  const list = expectSuccess(await delorun(home, ['trash', 'list'], 300_000), '`delorun trash list`')
  items['trash-list-cli'] = list.endedAt - list.startedAt
  return items
}

/** The suite. */
export const dataSuite: Suite = {
  id: 'data',
  title: 'Export, import and the trash',
  items: DATA_ITEMS,
  scenarios: [
    { id: 'small', description: 'A home with the small chat set' },
    { id: 'large', description: 'A home with the large chat set' },
  ],
  async run(context: SuiteContext, selected: readonly string[]): Promise<SuiteResult> {
    const fixtures = await context.fixtures()
    fixtures.channel.serve(await installedChannel(fixtures))
    const scenarios: ScenarioResult[] = []
    const skipped: Skipped[] = []
    for (const scenario of dataSuite.scenarios.filter(candidate => selected.includes(candidate.id))) {
      const count = scenario.id === 'small' ? context.options.chatsSmall : context.options.chatsLarge
      const chats = await chatIds(count)
      let workspace: string | undefined
      const template: BenchRoot = await templateHome(context, `data-chats-${String(count)}`, count, (root) => { workspace = gatherIntoWorkspace(root.deloHome, chats) })
      workspace ??= gatherIntoWorkspace(template.deloHome, [])
      if (workspace === undefined) skipped.push({ item: `${scenario.id}: export and import of a workspace`, reason: 'the installed home has no workspace registry entry to gather the chats into' })
      const samples = new Samples()
      const failures: string[] = []
      let completed = 0
      for (let index = 0; index < context.options.repeat; index++) {
        context.log(`data/${scenario.id}: repetition ${String(index + 1)} of ${String(context.options.repeat)}`)
        const root = context.newRoot()
        const home: InstalledHome = { root, launcher: fixtures.channel.launcher }
        try {
          copyHome(template, root)
          samples.addAll(await repetition(home, chats, workspace))
          completed++
        } catch (error) {
          failures.push(context.scrubber.scrub(error instanceof Error ? error.message : String(error)))
        } finally {
          await stopHome(home)
          root.dispose()
        }
      }
      scenarios.push({ scenario: scenario.id, description: scenario.description, parameters: { chats: count }, completed, phases: samples.results(Object.keys(DATA_ITEMS)), failures })
    }
    return { suite: 'data', scenarios, skipped }
  },
}
