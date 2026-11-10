/**
 * `delorun import-home` over scratch homes: the preview it prints before it
 * asks, a dry run that writes nothing at all, the yes the data needs and the
 * separate yes each category needs after it shows what lands, what is held
 * back and where, the refusals it prints with their code, and every name and
 * text from the stock home printed with its controls escaped. Each spec fails
 * when its check is removed.
 */
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_JOURNAL } from '@delo/archive/dsh-import'
import { CliError, EXIT } from '../../src/exit.ts'
import { MORE_QUESTION, PAGE_LINES, page, personHomeOf, stockHomeOf } from '../../src/import-home/index.ts'
import { main } from '../../src/main.ts'
import { chat, fresh, put, removeScratch, runCommand, snapshot, STOCK_SECRET, stockHome } from './support.ts'

afterEach(() => {
  removeScratch()
})

/**
 * A stock home in a scratch home directory, and a Delo home beside it that does not exist yet.
 * @returns the person's home directory, the stock home and the Delo home.
 */
function homes(): { readonly person: string, readonly source: string, readonly target: string } {
  const person = fresh('person')
  const source = join(person, '.dsh')
  stockHome(source)
  return { person, source, target: join(person, '.delo') }
}

/** The questions a full run asks, in order. */
const QUESTIONS = [
  'Copy your chats, attachments and workspace list into the Delo home? [y/N] ',
  'Copy 1 profile as shown, with their held-back rows written where nothing reads them? [y/N] ',
  'Copy these settings into the Delo home, with the held-back rows written where nothing reads them? [y/N] ',
  'Copy these instructions? Every chat in Delo reads them. [y/N] ',
  'Show the instructions of the skill "review"? [y/N] ',
  'Copy 1 skill? A skill can tell the agent what to do. [y/N] ',
  'Copy 1 stored key (DEEPSEEK_API_KEY) into the Delo home\'s credentials document, readable by you alone? [y/N] ',
]

/** The paths each category lands, and the data that lands with any yes to the data. */
const LANDS = {
  data: ['sessions/--work--/s1/session.v4.jsonl.zstd', 'sessions/_no-cwd/s2/session.v4.jsonl.zstd', 'storages/workspace.json', `${STOCK_IMPORT_DIRECTORY}/imports.json`],
  profiles: ['profiles/web/package.json', 'profiles/web/cordis.patch.yml', 'profiles/web/pnpm-workspace.yaml'],
  settings: ['cordis.patch.yml'],
  instructions: ['AGENTS.md'],
  skills: ['skills/review/SKILL.md'],
  credentials: ['.credentials.yaml'],
} as const

/**
 * The held-back files an import wrote.
 * @param target - the Delo home.
 * @returns their paths under the import's directory, each with the import's own directory name replaced by `import-*`.
 */
function heldFiles(target: string): string[] {
  const directory = join(target, STOCK_IMPORT_DIRECTORY)
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter(name => name.startsWith('import-')).flatMap(name =>
    snapshot(join(directory, name)).filter(entry => !entry.includes(' directory ')).map(entry => `import-*/${entry.split(' ')[0] as string}`))
}

describe('delorun import-home', () => {
  it('shows the whole preview on a dry run and writes nothing, not even the Delo home', async () => {
    const { person, source, target } = homes()
    const before = snapshot(source)
    const run = await runCommand(['--dry-run'], { home: target, env: { HOME: person } })
    expect(run.code).toBe(EXIT.ok)
    expect(run.asked).toEqual([])
    expect(run.out).toContain(`DeepSeek Harness home: ${JSON.stringify(source)} (read only; nothing in it changes)`)
    expect(run.out).toContain('Your chats and workspaces:\n  Chats: 2 chats to copy\n  Attachments: 1 file to copy\n  Workspaces: 1 registration, copied as the Delo home\'s workspace list\n    "work" at "/work": 1 chat\n')
    expect(run.out).toContain('Asked about one by one, and copied only if you say yes:')
    expect(run.out).toContain('      carried      "@deepseek-ai/dsh-base" (ships with DeepSeek Harness)')
    expect(run.out).toContain('      to install   "third-party-plugin" (from the registry, ^1.0.0)')
    expect(run.out).toContain('      not carried  "local-plugin" (installed from "file:/opt/local-plugin", which is not a registry version; if you trust it, add it again yourself)')
    expect(run.out).toContain('      added        "@delo/bundle-local" (Delo\'s own bundle, which keeps Delo\'s privacy defaults in this profile)')
    expect(run.out).toContain('      "profiles/web/cordis.patch.yml" (the profile\'s patch layer): lands with 1 row: "ui-chat"\n        It holds 1 !!js expression; none of them is carried.\n')
    expect(run.out).toContain('          "webapp": it holds a !!js expression, which runs when the profile starts\n')
    expect(run.out).toContain('    "cordis.patch.yml" (the home patch, which applies to every profile): lands with 1 row: "ui-theme"\n')
    expect(run.out).toMatch(/ {6}Held back, written where nothing reads it, "archive\/stock-import\/import-[0-9a-f-]+\/held\/cordis\.patch\.yml":\n {8}"sandbox": it is not one of the settings the import carries: the studio's looks and layout, the language and the default model by name \(a row the import does not carry\)\n/u)
    expect(run.out).toContain('  Instructions: "AGENTS.md", 1 line, which every chat reads; shown before you are asked')
    expect(run.out).toContain('    "review": 1 file, 60 bytes; "Reviews a change"')
    expect(run.out).toContain('    "DEEPSEEK_API_KEY": can be copied\n    "OTHER_KEY": not copied: only the DeepSeek key is offered; add other keys again in Delo\n')
    expect(run.out).toContain('  1 entry: logs, which Delo writes its own of\n    "logs"')
    expect(run.out).toContain('  1 entry: the install scripts the stock profile approved; a plugin\'s install script runs only after you approve it in Delo\n    "profiles/web/pnpm-workspace.yaml"')
    expect(run.out).toContain('Dry run: nothing was written.')
    expect(run.out).not.toContain(STOCK_SECRET)
    expect(existsSync(target)).toBe(false)
    expect(snapshot(source)).toEqual(before)
  })

  it('imports nothing without a yes to the data, and nothing without a terminal', async () => {
    const { person, target } = homes()
    for (const answers of [[], ['n'], ['maybe']]) {
      const refused = await runCommand([], { home: target, env: { HOME: person }, answers })
      expect(refused.error).toBeInstanceOf(CliError)
      expect((refused.error as CliError).message).toBe('delorun import-home: nothing was imported')
      expect(refused.asked).toEqual([QUESTIONS[0]])
      expect(existsSync(join(target, 'sessions'))).toBe(false)
    }
  })

  it('copies the data alone when every category is answered no, and asks each category on its own after the data', async () => {
    const { person, source, target } = homes()
    const before = snapshot(source)
    const run = await runCommand([], { home: target, env: { HOME: person }, answers: ['y', 'n', '', 'no', 'n', 'n', 'n'] })
    expect(run.code).toBe(EXIT.ok)
    expect(run.asked).toEqual(QUESTIONS)
    for (const path of LANDS.data) expect(existsSync(join(target, path))).toBe(true)
    for (const path of [...LANDS.profiles, ...LANDS.settings, ...LANDS.instructions, ...LANDS.skills, ...LANDS.credentials, 'settings.yaml']) expect(existsSync(join(target, path))).toBe(false)
    expect(heldFiles(target)).toEqual([])
    expect(run.out).toContain('Imported 2 chats, 1 attachment file, 1 workspace registration, 0 profiles, 0 documents, 0 skills and 0 stored keys.')
    expect(run.out).not.toContain('To start the profile')
    expect(snapshot(source)).toEqual(before)
  })

  // Five whole imports, each with its staged files synced, so the spec gets the time of five.
  it('lands each category only on its own yes, and nothing of the others', async () => {
    const categories = ['profiles', 'settings', 'instructions', 'skills', 'credentials'] as const
    for (const [index, category] of categories.entries()) {
      const { person, target } = homes()
      // The question that shows the skill's own instructions comes before the skills question.
      const answers = ['y', ...categories.flatMap((name, at) => [...name === 'skills' ? ['n'] : [], at === index ? 'y' : 'n'])]
      expect((await runCommand([], { home: target, env: { HOME: person }, answers })).code).toBe(EXIT.ok)
      for (const other of categories) {
        for (const path of LANDS[other]) expect([category, existsSync(join(target, path))]).toEqual([category, other === category])
      }
    }
  }, 60_000)

  it('lands what each yes showed: a manifest without scripts or paths, no build approval, plain rows only, held rows inert, the DeepSeek key alone', async () => {
    const { person, source, target } = homes()
    const before = snapshot(source)
    const run = await runCommand([], { home: target, env: { HOME: person }, answers: ['y', 'y', 'yes', 'y', 'y', 'y', 'y'] })
    expect(run.code).toBe(EXIT.ok)
    expect(run.asked).toEqual(QUESTIONS)
    // The whole text that lands is shown right before the question about it.
    expect(run.out).toContain('"profiles/web/package.json" lands as:\n  | {\n  |   "name": "dsh-profile-web",\n')
    expect(run.out).toContain('"profiles/web/cordis.patch.yml" lands as:\n  | - id: ui-chat\n  |   config:\n  |     linkOpening: new-tab\n')
    expect(run.out).toContain('"cordis.patch.yml" lands as:\n  | - id: ui-theme\n  |   config:\n  |     preference: dark\n')
    expect(run.out).toContain('"AGENTS.md" in full:\n  | # notes\n')
    expect(run.out).toContain('"skills/review":\n  "SKILL.md": 60 bytes\n')
    expect(run.out).toContain('"skills/review/SKILL.md" in full:\n  | ---\n  | name: review\n  | description: Reviews a change\n  | ---\n  | # review\n')
    const manifest = JSON.parse(readFileSync(join(target, 'profiles/web/package.json'), 'utf8')) as Record<string, unknown>
    expect(manifest).toEqual({ name: 'dsh-profile-web', private: true, dependencies: { 'third-party-plugin': '^1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'third-party-plugin', '@delo/bundle-local'] } } })
    expect(readFileSync(join(target, 'profiles/web/pnpm-workspace.yaml'), 'utf8')).not.toContain('allowBuilds')
    expect(readFileSync(join(target, 'profiles/web/cordis.patch.yml'), 'utf8')).not.toMatch(/!!js|webapp/u)
    expect(readFileSync(join(target, 'cordis.patch.yml'), 'utf8')).not.toMatch(/sandbox|runner/u)
    expect(readFileSync(join(target, 'cordis.patch.yml'), 'utf8')).toContain('ui-theme')
    expect(heldFiles(target).sort()).toEqual(['import-*/held/cordis.patch.yml', 'import-*/held/profiles/web/cordis.patch.yml'])
    const held = readdirSync(join(target, STOCK_IMPORT_DIRECTORY)).find(name => name.startsWith('import-')) as string
    expect(readFileSync(join(target, STOCK_IMPORT_DIRECTORY, held, 'held/cordis.patch.yml'), 'utf8')).toContain('runnerCommand: /tmp/runner')
    expect(readFileSync(join(target, STOCK_IMPORT_DIRECTORY, held, 'held/profiles/web/cordis.patch.yml'), 'utf8')).toContain('webapp')
    expect(readFileSync(join(target, 'AGENTS.md'), 'utf8')).toBe('# notes\n')
    expect(existsSync(join(target, 'skills/review/SKILL.md'))).toBe(true)
    const credentials = readFileSync(join(target, '.credentials.yaml'), 'utf8')
    expect(credentials).toContain(STOCK_SECRET)
    expect(credentials).not.toContain('OTHER_KEY')
    expect(statSync(join(target, '.credentials.yaml')).mode & 0o777).toBe(0o600)
    expect(statSync(target).mode & 0o777).toBe(0o700)
    expect(run.out).toContain('Imported 2 chats, 1 attachment file, 1 workspace registration, 1 profile, 3 documents, 1 skill and 1 stored key.')
    expect(run.out).toMatch(/Held-back rows are in "archive\/stock-import\/import-[0-9a-f-]+\/held\/profiles\/web\/cordis\.patch\.yml", "archive\/stock-import\/import-[0-9a-f-]+\/held\/cordis\.patch\.yml"; nothing there takes effect\./u)
    expect(run.out).toContain('To install the plugins of the profile "web": delorun plugin --profile web install')
    expect(run.out).toContain('To start the profile "web": delorun --profile web')
    expect(run.out).not.toContain(STOCK_SECRET)
    expect(snapshot(source)).toEqual(before)
  })

  it('shows long instructions a screenful at a time with their controls escaped, and says what a stop left unread', async () => {
    const { person, source, target } = homes()
    put(source, 'AGENTS.md', Array.from({ length: 45 }, (_, index) => `line ${String(index)} \u001b[2J`).join('\n'))
    // Data yes, profiles and settings no, then stop reading the instructions after the first screenful.
    const run = await runCommand([], { home: target, env: { HOME: person }, answers: ['y', 'n', 'n', 'q', 'n', 'n', 'n', 'n'] })
    expect(run.asked.slice(0, 5)).toEqual([QUESTIONS[0], QUESTIONS[1], QUESTIONS[2], MORE_QUESTION, QUESTIONS[3]])
    expect(run.out).toContain('"AGENTS.md" in full:\n  | line 0 \\u001b[2J\n')
    expect(run.out).toContain(`  | line ${String(PAGE_LINES - 2)} \\u001b[2J\nThe rest was not shown (6 more lines); the answer below starts on no.\n`)
    expect(run.out).not.toContain(`line ${String(PAGE_LINES - 1)} `)
    expect(run.out).not.toMatch(/\u001b/u)
    expect(existsSync(join(target, 'AGENTS.md'))).toBe(false)
    // Enter goes on to the end.
    const again = homes()
    put(again.source, 'AGENTS.md', Array.from({ length: 45 }, (_, index) => `line ${String(index)}`).join('\n'))
    const read = await runCommand([], { home: again.target, env: { HOME: again.person }, answers: ['y', 'n', 'n', '', 'y', 'n', 'n', 'n'] })
    expect(read.out).toContain('  | line 44\n')
    expect(readFileSync(join(again.target, 'AGENTS.md'), 'utf8')).toContain('line 44')
  })

  it('pages any text, and stops when the person types q in any case', async () => {
    let out = ''
    const asked: string[] = []
    const lines = Array.from({ length: PAGE_LINES * 2 + 1 }, (_, index) => String(index))
    expect(await page(lines, { stdout: (text) => { out += text }, ask: async (question) => { asked.push(question); return ' Q ' } })).toBe(false)
    expect(asked).toEqual([MORE_QUESTION])
    expect(out).toBe(`${lines.slice(0, PAGE_LINES).join('\n')}\nThe rest was not shown (${String(PAGE_LINES + 1)} more lines); the answer below starts on no.\n`)
    expect(await page([], { stdout: () => { throw new Error('nothing to show') }, ask: async () => '' })).toBe(true)
  })

  it('asks no category question when the stock home holds only data', async () => {
    const person = fresh('person')
    chat(join(person, '.dsh'), '_no-cwd', 's1', undefined)
    const run = await runCommand([], { home: join(person, '.delo'), env: { HOME: person }, answers: ['y'] })
    expect(run.code).toBe(EXIT.ok)
    expect(run.asked).toEqual([QUESTIONS[0]])
  })

  it('refuses a Delo home that holds chats without --merge, and prints each reason with its code', async () => {
    const { person, target } = homes()
    mkdirSync(target, { mode: 0o700 })
    put(target, 'sessions/--other--/d1/session.v4.jsonl.zstd', 'a Delo chat')
    put(target, 'sessions/--work--/s1/session.v4.jsonl.zstd', 'another chat with the same id')
    for (const args of [['--dry-run'], [], ['--merge', '--dry-run']]) {
      const run = await runCommand(args, { home: target, env: { HOME: person }, answers: ['y'] })
      expect(run.error).toBeInstanceOf(CliError)
      expect(run.asked).toEqual([])
      expect((run.error as CliError).message).toContain('delorun import-home: the import cannot go on, so nothing was imported:')
      expect((run.error as CliError).message).toContain('DSH_IMPORT_ID_COLLISION: the Delo home already holds the chat "s1" with other content')
    }
    expect(readFileSync(join(target, 'sessions/--work--/s1/session.v4.jsonl.zstd'), 'utf8')).toBe('another chat with the same id')
    const first = await runCommand([], { home: target, env: { HOME: person } })
    expect((first.error as CliError).message).toContain('DSH_IMPORT_HOME_HAS_CHATS')
  })

  it('withdraws an interrupted import before it plans, keeps a file Delo wrote to since, and says so', async () => {
    const { person, target } = homes()
    mkdirSync(target, { mode: 0o700 })
    const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
    put(target, `${STOCK_IMPORT_DIRECTORY}/staging-x/files/AGENTS.md`, 'withdrawn notes')
    linkSync(join(target, STOCK_IMPORT_DIRECTORY, 'staging-x/files/AGENTS.md'), join(target, 'AGENTS.md'))
    put(target, `${STOCK_IMPORT_DIRECTORY}/staging-x/files/kept.md`, 'placed')
    linkSync(join(target, STOCK_IMPORT_DIRECTORY, 'staging-x/files/kept.md'), join(target, 'kept.md'))
    writeFileSync(join(target, 'kept.md'), 'placed, then written to by Delo')
    put(target, `${STOCK_IMPORT_DIRECTORY}/${STOCK_IMPORT_JOURNAL}`, JSON.stringify({ v: 1, staging: 'staging-x', directories: [], entries: [
      { path: 'AGENTS.md', replace: false, sha256: digest('withdrawn notes') },
      { path: 'kept.md', replace: false, sha256: digest('placed') },
    ] }))
    const run = await runCommand([], { home: target, env: { HOME: person }, answers: ['y'] })
    expect(run.out).toContain('Withdrew an import that was interrupted: 1 file it had placed.')
    expect(run.out).toContain('Left in place because Delo wrote to them since: "kept.md".')
    expect(existsSync(join(target, 'AGENTS.md'))).toBe(false)
    expect(readFileSync(join(target, 'kept.md'), 'utf8')).toBe('placed, then written to by Delo')
    expect(existsSync(join(target, STOCK_IMPORT_DIRECTORY, 'staging-x'))).toBe(false)
  })

  it('refuses a total over --max-size and prints the refusal with its code, and imports within a larger one', async () => {
    const { source, target } = homes()
    const run = await runCommand(['--from', source, '--max-size', '10', '--dry-run'], { home: target })
    expect((run.error as CliError).message).toMatch(/^delorun import-home: the import is refused \(DSH_IMPORT_(ENTRY|TOTAL)_TOO_LARGE\)/u)
    const total = await runCommand(['--from', source, '--max-size', '400', '--dry-run'], { home: target })
    expect((total.error as CliError).message).toContain('(DSH_IMPORT_TOTAL_TOO_LARGE)')
    expect((total.error as CliError).message).toContain('--max-size')
    expect((total.error as CliError).message).toContain('nothing was imported')
    expect((await runCommand(['--from', source, '--max-size', '100000', '--dry-run'], { home: target })).code).toBe(EXIT.ok)
  })

  it('takes --from with a leading ~, and refuses a missing stock home and a wrong command line with the usage code', async () => {
    const { target } = homes()
    const missing = await runCommand(['--from', join(target, 'nowhere'), '--dry-run'], { home: target })
    expect((missing.error as CliError).message).toContain('DSH_IMPORT_SOURCE_UNUSABLE')
    for (const args of [['--max-size', '0'], ['--max-size', '1e9'], ['--max-size', '99999999999999999'], ['--nope'], ['extra']]) {
      expect(((await runCommand(args, { home: target, env: { HOME: '/' } })).error as CliError).exit).toBe(EXIT.usage)
    }
    const noHome = await runCommand(['--dry-run'], { home: target, env: { HOME: ' ' } })
    expect((noHome.error as CliError).message).toContain('give the DeepSeek Harness home with --from')
    const tilde = await runCommand(['--from', '~/no-such-stock-home-for-this-spec', '--dry-run'], { home: target })
    expect((tilde.error as CliError).message).toContain('DSH_IMPORT_SOURCE_UNUSABLE')
  })

  it('prints every name from the stock home with its controls escaped', async () => {
    const { source, target } = homes()
    put(source, 'skills/\u001b[2Jevil/SKILL.md', 'x')
    put(source, 'mystery\u202e/x', 'x')
    put(source, 'profiles/x\u001b]0;title\u0007/package.json', '{}')
    const run = await runCommand(['--from', source, '--dry-run'], { home: target })
    expect(run.out).not.toMatch(/[\u001b\u0007\u202e]/u)
    expect(run.out).toContain('"skills/\\u001b[2Jevil"')
    expect(run.out).toContain('"mystery\\u202e"')
  })

  it('names the stock home from the person\'s home directory', () => {
    expect(stockHomeOf({ HOME: '/home/someone' })).toBe(join('/home/someone', '.dsh'))
    expect(stockHomeOf({ USERPROFILE: 'C:\\Users\\someone' })).toBe(join('C:\\Users\\someone', '.dsh'))
    expect(stockHomeOf({})).toBeUndefined()
    expect(personHomeOf({ HOME: ' ', USERPROFILE: '/x' })).toBeUndefined()
  })

  it('holds back a workspace in a hidden folder of the person\'s home with its chats, and a chat working outside its workspace', async () => {
    const { person, source, target } = homes()
    const keys = join(person, '.ssh')
    chat(source, '--keys--', 'k1', keys)
    chat(source, '--work--', 's3', '/elsewhere')
    put(source, 'storages/workspace.json', `${JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: ['w1', 'w2'], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {
      w1: { path: '/work', title: 'work', sessionIds: ['s1', 's3'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      w2: { path: keys, title: 'keys', sessionIds: ['k1'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    } } })}\n`)
    const run = await runCommand(['--dry-run'], { home: target, env: { HOME: person } })
    expect(run.out).toContain(`    "keys" at ${JSON.stringify(keys)}: held back, with its chats: a hidden folder of your home folder, where settings and keys live\n`)
    expect(run.out).toContain('    "work" at "/work": 1 chat\n')
    expect(run.out).toContain('"sessions/--keys--/k1"')
    expect(run.out).toContain('"sessions/--work--/s3": it works in "/elsewhere", outside its workspace "work" at "/work"')
  })

  it('is a row of the command table that a dry run reaches through main', async () => {
    const { person, target } = homes()
    let out = ''
    let err = ''
    const code = await main(['import-home', '--dry-run', '--profile', 'default'], { env: { HOME: person, DELO_HOME: target }, stdout: (text) => { out += text }, stderr: (text) => { err += text } })
    expect(err).toBe('')
    expect(code).toBe(EXIT.ok)
    expect(out).toContain('Dry run: nothing was written.')
    expect(existsSync(target)).toBe(false)
    // Without a terminal nothing is asked, so the real import holds the home's locks, asks nothing and imports nothing.
    let refused = ''
    expect(await main(['import-home'], { env: { HOME: person, DELO_HOME: target }, stdout: () => undefined, stderr: (text) => { refused += text } })).toBe(EXIT.failed)
    expect(refused).toBe('delorun import-home: nothing was imported\n')
    expect(existsSync(join(target, 'sessions'))).toBe(false)
    let help = ''
    await main(['--help'], { env: {}, stdout: (text) => { help += text }, stderr: () => undefined })
    expect(help).toContain('import-home')
  })
})
