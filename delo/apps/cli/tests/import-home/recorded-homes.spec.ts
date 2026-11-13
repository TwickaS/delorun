/**
 * `delorun import-home` over two stock homes recorded from real runs of stock DeepSeek Harness, in
 * `fixtures/terminal-home/.dsh` and `fixtures/web-home/.dsh`, laid out as a person's `~/.dsh`. Both were recorded on 2026-11-11 with this repository's `dsh`,
 * run from source with `HOME=/tmp/stock-person-a` or `/tmp/stock-person-b` and `DSH_HOME` at `.dsh` beside it, and a
 * real model answering, so their chat logs, workspace list and profiles are the bytes stock wrote.
 *
 * - The terminal home: two `dsh headless` chats in two project folders, one of them resumed for a second turn; a
 *   `settings.yaml` that stock moved into the profile on its next start; a local plugin added with
 *   `dsh plugin --profile headless add file:…`; `AGENTS.md` and a skill.
 * - The web home: a `dsh headless` chat in a project, one in the person's home folder itself, and one killed with
 *   SIGKILL in the middle of its turn; one `dsh web` start, whose workspace plugin built the workspace list from those
 *   chats and stored its browser-session secret; the same local plugin added to the `web` profile.
 *
 * Edited by hand afterwards, as a person would: the patch rows (a theme, a default-model effort, a provider address,
 * an inline web-search key, a trusted host, the rows that load the plugin) and the keys. Every key and secret is a
 * placeholder named in {@link SECRETS}. Removed before committing: each profile's installed `node_modules`, and the
 * terminal home's profile history, a git repository whose loose objects the repository's text checks would read as
 * text. The recording account's name in two `ls -l` outputs inside the logs was
 * replaced by `stock`, in the one frame that held it, recompressed with upstream's `compressZstdFrame`, because
 * upstream reads a log only as its own checksummed frames.
 */
import { chmodSync, cpSync, existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { EXIT } from '../../src/exit.ts'
import { MORE_QUESTION } from '../../src/import-home/index.ts'
import { fresh, removeScratch, runCommand, snapshot } from './support.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** The person's home directory each home was recorded under, which the import's folder rules compare against. */
const PERSON = { 'terminal-home': '/tmp/stock-person-a', 'web-home': '/tmp/stock-person-b' } as const

/** The placeholder keys and secrets the recorded homes hold. */
const SECRETS = {
  terminalKey: 'sk-recorded-terminal-home-not-a-key',
  webKey: 'sk-recorded-web-home-not-a-key',
  webSearchKey: 'sk-recorded-web-search-not-a-key',
  githubToken: 'recorded-github-token-not-a-token',
  browserSession: 'recorded-browser-session-not-a-secret',
} as const

/** The recorded chats, by what they are. */
const CHATS = {
  notes: 'session-e196e21b-177b-43c8-87c1-af5f2af30cdf',
  scripts: 'session-38cc30a2-5d98-41b7-9d5a-31b9e5b5f304',
  site: 'session-78f4e1f0-d9c6-4f7e-9751-735d8a0ad319',
  interrupted: 'session-a4ba3ec3-05fe-4e5d-a6b9-686425d62442',
  homeFolder: 'session-cf8e1d33-3b5d-4693-8fce-366e7a722f19',
} as const

afterEach(removeScratch)

/**
 * Copy one recorded home into a scratch folder as `.dsh`, with the credentials document at the mode stock writes.
 * @param name - the fixture.
 * @returns the stock home, the Delo home to import into, and the environment naming the recorded person's home.
 */
function recorded(name: keyof typeof PERSON): { source: string, target: string, env: Record<string, string> } {
  const scratch = fresh('recorded')
  const source = join(scratch, '.dsh')
  cpSync(join(FIXTURES, name, '.dsh'), source, { recursive: true })
  chmodSync(join(source, '.credentials.yaml'), 0o600)
  return { source, target: join(scratch, '.delo'), env: { HOME: PERSON[name] } }
}

/**
 * Answer yes to every import question, read every page to the end, and never ask to see a skill's instructions.
 * @param question - the question.
 * @returns the answer.
 */
function yesToAll(question: string): string {
  if (question === MORE_QUESTION) return ''
  return question.startsWith('Show the instructions') ? 'n' : 'y'
}

/**
 * Every regular file of a tree whose bytes hold a text.
 * @param root - the tree.
 * @param text - the text.
 * @returns the paths relative to the tree, sorted.
 */
function holding(root: string, text: string): readonly string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const stats = lstatSync(path)
      if (stats.isDirectory()) walk(path)
      else if (stats.isFile() && readFileSync(path).includes(text)) found.push(relative(root, path))
    }
  }
  walk(root)
  return found.sort()
}

/**
 * Read every chat of a sessions root through upstream's own JSONL Session persistence.
 * @param root - the sessions root.
 * @returns each chat's events, by its id.
 */
async function upstreamChats(root: string): Promise<Record<string, readonly SessionEvent[]>> {
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root })
    const store = ctx.sessionPersistence
    const chats: Record<string, readonly SessionEvent[]> = {}
    for (const { header } of await store.list()) {
      const handle = await store.open(header.id, 'read')
      try {
        chats[header.id] = (await handle.read()).events
      } finally {
        await handle.close()
      }
    }
    return chats
  } finally {
    await ctx.fiber.dispose()
  }
}

describe('delorun import-home over recorded stock homes', () => {
  it('carries a terminal person\'s chats, instructions, skill and key, and leaves the reserved headless profile and the stock home as they were', async () => {
    const { source, target, env } = recorded('terminal-home')
    const before = snapshot(source)

    const run = await runCommand(['--from', source], { home: target, env, answer: yesToAll })

    expect(run.error).toBeUndefined()
    expect(run.code).toBe(EXIT.ok)
    expect(run.out).toContain('Imported 2 chats, 0 attachment files, 0 workspace registrations, 0 profiles, 2 documents, 1 skill and 1 stored key.')
    // `delorun headless` sets up profiles/headless for itself, so the stock one stays behind with C1's reason.
    expect(run.out).toContain('    "profiles/headless": "headless" is reserved: it is the profile `delorun headless` boots')
    expect(run.out).not.toContain('delorun --profile headless')
    expect(existsSync(join(target, 'profiles'))).toBe(false)
    const stock = await upstreamChats(join(recorded('terminal-home').source, 'sessions'))
    expect(Object.keys(stock).sort()).toEqual([CHATS.scripts, CHATS.notes].sort())
    expect(await upstreamChats(join(target, 'sessions'))).toEqual(stock)
    expect(readFileSync(join(target, 'AGENTS.md'), 'utf8')).toBe(readFileSync(join(source, 'AGENTS.md'), 'utf8'))
    expect(readFileSync(join(target, 'skills/commit-message/SKILL.md'), 'utf8')).toBe(readFileSync(join(source, 'skills/commit-message/SKILL.md'), 'utf8'))
    // The provider address is held back where nothing reads it; the home patch that every profile reads gets no row.
    expect(readFileSync(join(target, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    expect(holding(target, 'llm-proxy.example.com')).toEqual([expect.stringMatching(/^archive\/stock-import\/import-[^/]+\/held\/cordis\.patch\.yml$/u)])
    expect(holding(target, SECRETS.terminalKey)).toEqual(['.credentials.yaml'])
    expect(lstatSync(join(target, '.credentials.yaml')).mode & 0o777).toBe(0o600)
    expect(run.out).not.toContain(SECRETS.terminalKey)
    expect(snapshot(source)).toEqual(before)
  }, 120_000)

  it('carries a web person\'s finished chat, its workspace, the web profile\'s looks and the DeepSeek key, and holds the rest back', async () => {
    const { source, target, env } = recorded('web-home')
    const before = snapshot(source)

    const run = await runCommand(['--from', source], { home: target, env, answer: yesToAll })

    expect(run.error).toBeUndefined()
    expect(run.code).toBe(EXIT.ok)
    expect(run.out).toContain('Imported 1 chat, 0 attachment files, 1 workspace registration, 1 profile, 1 document, 0 skills and 1 stored key.')
    expect(run.out).toContain('    "stock-person-b" at "/tmp/stock-person-b": held back, with its chats: your home folder itself')
    expect(run.out).toContain('1 chat stopped in the middle of a turn and stays behind')
    expect(run.out).toContain(`    "sessions/--tmp-stock-person-b-projects-site--/${CHATS.interrupted}"`)
    expect(Object.keys(await upstreamChats(join(target, 'sessions')))).toEqual([CHATS.site])
    const list = JSON.parse(readFileSync(join(target, 'storages/workspace.json'), 'utf8')) as { global: { workspaceIds: string[] }, tables: { workspaces: Record<string, { path: string, sessionIds: string[] }> } }
    expect(list.global.workspaceIds).toHaveLength(1)
    expect(Object.values(list.tables.workspaces).map(workspace => [workspace.path, workspace.sessionIds])).toEqual([['/tmp/stock-person-b/projects/site', [CHATS.site]]])
    // The web profile lands with its looks; the local plugin, the web-search key, the trusted host and the stock
    // headless profile do not.
    expect(readdirSync(join(target, 'profiles'))).toEqual(['web'])
    const manifest = JSON.parse(readFileSync(join(target, 'profiles/web/package.json'), 'utf8')) as Record<string, unknown>
    expect(manifest).toEqual({ name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@delo/bundle-local'] } } })
    expect(run.out).toContain('      not carried  "word-count" (installed from "file:/tmp/stock-person-b/plugins/word-count", which is not a registry version; if you trust it, add it again yourself)')
    expect(readFileSync(join(target, 'profiles/web/cordis.patch.yml'), 'utf8')).toBe('- id: ui-theme\n  config:\n    preference: dark\n    codeFontFamily: JetBrains Mono, monospace\n- id: ui-chat\n  config:\n    linkOpening: new-tab\n')
    const [held] = holding(target, 'laptop.local:8080')
    expect(held).toMatch(/^archive\/stock-import\/import-[^/]+\/held\/profiles\/web\/cordis\.patch\.yml$/u)
    expect(lstatSync(join(target, held as string)).mode & 0o777).toBe(0o600)
    // No key or secret lands in a profile or patch file; the DeepSeek key is in the credentials document alone.
    expect(holding(target, SECRETS.webKey)).toEqual(['.credentials.yaml'])
    expect(holding(target, SECRETS.webSearchKey)).toEqual([held])
    expect(holding(target, SECRETS.githubToken)).toEqual([])
    expect(holding(target, SECRETS.browserSession)).toEqual([])
    for (const secret of Object.values(SECRETS)) expect(run.out).not.toContain(secret)
    expect(snapshot(source)).toEqual(before)
  }, 120_000)

  it('lands the data alone when the person says no to every category: no instructions, skill or key', async () => {
    const { source, target, env } = recorded('terminal-home')

    const run = await runCommand(['--from', source], { home: target, env, answer: question => question.startsWith('Copy your chats') ? 'y' : question === MORE_QUESTION ? '' : 'n' })

    expect(run.code).toBe(EXIT.ok)
    expect(run.out).toContain('Imported 2 chats, 0 attachment files, 0 workspace registrations, 0 profiles, 0 documents, 0 skills and 0 stored keys.')
    expect(existsSync(join(target, 'skills'))).toBe(false)
    expect(holding(target, SECRETS.terminalKey)).toEqual([])
    expect(holding(target, 'House rules')).toEqual([])
  }, 120_000)

  it('refuses a second import into the same Delorun home and changes nothing; with --merge it copies nothing again', async () => {
    const { source, target, env } = recorded('terminal-home')
    expect((await runCommand(['--from', source], { home: target, env, answer: yesToAll })).code).toBe(EXIT.ok)
    const imported = snapshot(target)

    const again = await runCommand(['--from', source], { home: target, env, answer: yesToAll })

    expect(again.code).toBeUndefined()
    expect(String(again.error)).toContain('DSH_IMPORT_HOME_HAS_CHATS: the Delorun home already holds 2 chats; to add these beside them, run the import again with --merge')
    expect(again.asked).toEqual([])
    expect(snapshot(target)).toEqual(imported)

    const merged = await runCommand(['--from', source, '--merge'], { home: target, env, answer: yesToAll })

    expect(merged.code).toBe(EXIT.ok)
    expect(merged.out).toContain('Imported 0 chats, 0 attachment files, 0 workspace registrations, 0 profiles, 0 documents, 0 skills and 0 stored keys.')
    expect(merged.out).toContain('    "DEEPSEEK_API_KEY": already in the Delorun home')
    // Only the import's own record and a fresh copy of the held-back rows are new.
    expect(snapshot(target).filter(entry => !entry.startsWith('archive/stock-import/'))).toEqual(imported.filter(entry => !entry.startsWith('archive/stock-import/')))
  }, 120_000)
})
