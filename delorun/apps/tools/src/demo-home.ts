/**
 * Build a demonstration Delorun home for the product's pictures: invented workspaces and chats in a home that holds no
 * model key and has never called a model. The chats are written by the DeepSeek chat import's own upload route, which
 * stores Sessions in the home's `sessions` folder and registers the workspaces in `storages`, so the studio reads them as
 * any other history. Run from the repository root with the studio stopped and after `pnpm run build:artifacts`:
 *
 * `node_modules/.bin/tsx delorun/apps/tools/src/demo-home.ts --home <dir> [--projects <dir>] [--no-chats] [--no-setup]`
 *
 * `--home` is a new or empty folder (mode 700 is set) and `--projects` is where the invented project folders go,
 * `<home>/../projects` by default. Setup runs first, with a placeholder key that no request ever uses, unless
 * `--no-setup` is given. `--no-chats` stops after setup: the fresh home that the first-run guide's picture needs.
 * The procedure and the pictures it serves are in `delorun/apps/tools/README.md`.
 *
 * @module @delorun/tools/demo-home
 */
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { strToU8, zipSync } from 'fflate'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as DeepseekChatImport from '@deepseek-ai/dsh-deepseek-chat-import'
import * as SessionStore from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SessionProjection from '@deepseek-ai/dsh-session-projection'
import * as SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as Workspace from '@deepseek-ai/dsh-workspace'
import { DEMO_WORKSPACES, type DemoChat, type DemoWorkspace } from './demo-home/content.ts'

/** The upload route of the chat import plugin. */
const UPLOAD_PATH = '/api/deepseek-chat-import/archive'

/** The placeholder key setup is given; the demonstration home never sends a request to a model. */
export const PLACEHOLDER_KEY = 'sk-demonstration-placeholder-never-sent'

/** What the build made. */
export interface DemoHomeResult {
  /** The workspaces registered, with the number of chats each holds. */
  readonly workspaces: readonly { readonly path: string, readonly chats: number }[]
}

/**
 * One chat as the DeepSeek export file stores it.
 * @param id - the conversation id.
 * @param chat - the invented chat.
 * @param now - the build time in epoch milliseconds.
 * @returns the export's conversation file content.
 */
export function exportedConversation(id: string, chat: DemoChat, now: number): Record<string, unknown> {
  const end = now - chat.minutesAgo * 60_000
  const first = end - chat.turns.length * 4 * 60_000
  const at = (turn: number, answer: boolean): string => new Date(first + turn * 4 * 60_000 + (answer ? 90_000 : 0)).toISOString()
  const messages = chat.turns.flatMap((turn, index) => [
    { id: index * 2 + 1, parent_id: index === 0 ? null : index * 2, role: 'USER', status: 'FINISHED', inserted_at: at(index, false), fragments: [{ type: 'REQUEST', content: turn.ask }] },
    { id: index * 2 + 2, parent_id: index * 2 + 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: at(index, true), fragments: [{ type: 'RESPONSE', content: turn.answer }] },
  ])
  return { id, title: chat.title, inserted_at: new Date(first).toISOString(), messages }
}

/**
 * The export archive of one workspace's chats.
 * @param workspace - the workspace.
 * @param now - the build time in epoch milliseconds.
 * @returns the zip bytes in the DeepSeek export format.
 */
export function exportArchive(workspace: DemoWorkspace, now: number): Uint8Array {
  const files: Record<string, Uint8Array> = { 'manifest.json': strToU8('{"export_format_version":3}') }
  const index = workspace.chats.map((chat, number) => {
    const id = `${workspace.folder}-${number + 1}`
    const conversation = exportedConversation(id, chat, now)
    files[`chat_sessions/${id}.json`] = strToU8(JSON.stringify(conversation))
    return { id, title: chat.title, pinned: false, inserted_at: conversation.inserted_at, updated_at: new Date(now - chat.minutesAgo * 60_000).toISOString(), message_count: chat.turns.length * 2 }
  })
  files['chat_session_index.json'] = strToU8(JSON.stringify(index))
  return zipSync(files)
}

/**
 * Write the project folders and import the chats into the home's stores.
 * @param home - the Delorun home, with the studio stopped.
 * @param projects - the folder that receives the project folders.
 * @param now - the build time in epoch milliseconds.
 * @returns what was made.
 * @throws {Error} when an import answers anything but success.
 */
export async function writeDemoChats(home: string, projects: string, now: number): Promise<DemoHomeResult> {
  const scratch = await realpath(await mkdtemp(join(await realpath(dirname(home)), '.demo-home-')))
  const context = new Context()
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  try {
    const configPath = join(scratch, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-persistence-jsonl'", '  config:', `    root: ${JSON.stringify(join(home, 'sessions'))}`,
      "- name: '@deepseek-ai/dsh-storage'",
      "- name: '@deepseek-ai/dsh-storage-json'", '  config:', `    root: ${JSON.stringify(join(home, 'storages'))}`,
      "- name: '@deepseek-ai/dsh-storage-domain'", '  config:', '    backend: json',
      "- name: '@deepseek-ai/dsh-workspace'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-session-projection-cache'", '  config:', '    writeEveryEvents: 1', '    writeIntervalMs: 1000',
      "- name: '@deepseek-ai/dsh-typert-registry'",
      '- id: deepseek-chat-import', "  name: '@deepseek-ai/dsh-deepseek-chat-import'", '',
    ].join('\n'))
    context.baseUrl = pathToFileURL(scratch).href + '/'
    context.provide('connection', {
      fetch: { register: (route: { path: string, fetch: (request: Request) => Promise<Response> }) => {
        routes.set(route.path, route.fetch)
        return () => { routes.delete(route.path); return Promise.resolve() }
      } },
    } as never)
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', SessionStore], ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlPersistence],
      ['@deepseek-ai/dsh-storage', Storage], ['@deepseek-ai/dsh-storage-json', StorageJson], ['@deepseek-ai/dsh-storage-domain', StorageDomain],
      ['@deepseek-ai/dsh-workspace', Workspace], ['@deepseek-ai/dsh-session-projection', SessionProjection],
      ['@deepseek-ai/dsh-session-projection-cache', SessionProjectionCache], ['@deepseek-ai/dsh-typert-registry', TypertRegistry],
      ['@deepseek-ai/dsh-deepseek-chat-import', DeepseekChatImport],
    ])
    context.loader.internal = { version: 'v2', import: (specifier: string) => Promise.resolve(modules.get(specifier)) } as never
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const result: { path: string, chats: number }[] = []
    for (const spec of DEMO_WORKSPACES) {
      const path = join(projects, spec.folder)
      for (const [name, text] of Object.entries(spec.files)) {
        await mkdir(dirname(join(path, name)), { recursive: true })
        await writeFile(join(path, name), text)
      }
      const workspace = await context.workspaceRegistry.create(await realpath(path))
      const route = routes.get(UPLOAD_PATH)
      if (route === undefined) throw new Error('the chat import registered no upload route')
      const response = await route(new Request(`http://127.0.0.1${UPLOAD_PATH}?workspaceId=${workspace.id}`, {
        method: 'POST', body: new Uint8Array(exportArchive(spec, now)), headers: { 'content-type': 'application/octet-stream' },
      }))
      const last = (await response.text()).split('\n').filter(line => line !== '').at(-1) ?? ''
      if (!last.includes('"ok":true')) throw new Error(`importing the chats of ${spec.folder} failed: ${last}`)
      result.push({ path, chats: spec.chats.length })
    }
    return { workspaces: result }
  } finally {
    await context.fiber.dispose()
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Run `delorun setup --yes` from source on the home, with the placeholder key.
 * @param root - the repository root.
 * @param home - the home to set up.
 * @param user - a neutral folder used as the user's home directory for the run.
 * @returns when setup has finished.
 * @throws {Error} when setup exits with a failure.
 */
export async function setupDemoHome(root: string, home: string, user: string): Promise<void> {
  const tsx = join(root, 'node_modules', '.bin', 'tsx')
  const env = { ...process.env, HOME: user, DELORUN_HOME: home, DEMO_HOME_KEY: PLACEHOLDER_KEY }
  await new Promise<void>((done, fail) => {
    const child = spawn(tsx, [join(root, 'delorun/apps/cli/src/bin.ts'), 'setup', '--yes', '--provider', 'deepseek-official', '--key-env', 'DEMO_HOME_KEY', '--no-update-check'], { cwd: join(root, 'delorun/apps/cli'), env, stdio: 'inherit' })
    child.on('error', fail)
    child.on('exit', code => { code === 0 ? done() : fail(new Error(`delorun setup exited with ${code}`)) })
  })
}

/** Run the command line. */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { home: { type: 'string' }, projects: { type: 'string' }, 'no-chats': { type: 'boolean' }, 'no-setup': { type: 'boolean' } } })
  if (values.home === undefined) throw new Error('usage: demo-home.ts --home <dir> [--projects <dir>] [--no-chats] [--no-setup]')
  const home = resolve(values.home)
  const projects = resolve(values.projects ?? join(dirname(home), 'projects'))
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  await mkdir(home, { recursive: true })
  await chmod(home, 0o700)
  await mkdir(projects, { recursive: true })
  if (values['no-setup'] !== true) await setupDemoHome(root, home, dirname(home))
  if (values['no-chats'] === true) return
  const made = await writeDemoChats(home, projects, Date.now())
  for (const workspace of made.workspaces) process.stdout.write(`${workspace.path}: ${workspace.chats} chats\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`demo-home: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
