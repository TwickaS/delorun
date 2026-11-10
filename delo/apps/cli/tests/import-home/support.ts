/**
 * The fixtures of the `delorun import-home` specs: scratch directories, a
 * stock home shaped with arbitrary chat bytes, the run of the command with a
 * scripted terminal, and the snapshot that proves a tree is byte-identical.
 */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import { withHomeExclusive } from '../../src/home-exclusion.ts'
import { runImportHome, type ImportHomeIo } from '../../src/import-home/index.ts'
import type { ExitCode } from '../../src/exit.ts'

const scratch: string[] = []

/**
 * A fresh directory, removed by {@link removeScratch}.
 * @param name - its prefix.
 * @returns its path.
 */
export function fresh(name: string): string {
  const path = mkdtempSync(join(tmpdir(), `delorun-${name}-`))
  scratch.push(path)
  return path
}

/** Remove every directory {@link fresh} made. */
export function removeScratch(): void {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
}

/**
 * Write one file, creating its directories.
 * @param root - the tree.
 * @param path - the relative path.
 * @param content - the content.
 * @param mode - the permission bits.
 */
export function put(root: string, path: string, content: string | Buffer, mode = 0o644): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content, { mode })
}

/** The stock key of the fixtures; no output may contain it. */
export const STOCK_SECRET = 'sk-stock-fixture-91ab'

/**
 * Snapshot a tree: each path with its content digest and permission bits.
 * @param root - the tree.
 * @returns the entries in path order, or an empty list when the tree does not exist.
 */
export function snapshot(root: string): readonly string[] {
  const entries: string[] = []
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const stats = lstatSync(path)
      const digest = stats.isDirectory() ? 'directory' : stats.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'other'
      entries.push(`${relative(root, path)} ${digest} ${(stats.mode & 0o777).toString(8)}`)
      if (stats.isDirectory()) walk(path)
    }
  }
  try {
    walk(root)
  } catch (error: unknown) {
    // ENOENT: a tree that does not exist holds nothing.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return entries
}

/** What one run of the command printed and asked. */
export interface Run {
  readonly code: ExitCode | undefined
  readonly out: string
  readonly asked: readonly string[]
  readonly error: unknown
}

/**
 * Run `delorun import-home` with a scripted terminal.
 * @param args - the arguments after `import-home`.
 * @param io - the home, and the environment, answers and profile to change.
 * @returns the exit code or the failure, what it printed and what it asked.
 */
export async function runCommand(args: readonly string[], io: { readonly home: string, readonly env?: Record<string, string | undefined>, readonly answers?: readonly string[], readonly profile?: string }): Promise<Run> {
  let out = ''
  const asked: string[] = []
  const answers = [...io.answers ?? []]
  const exclusive: ImportHomeIo['exclusive'] = run => withHomeExclusive({ home: io.home, profile: 'default', command: 'import-home', instead: '' }, run, { probe: () => async () => 'answered', runtime: brandString<RuntimeVersion>('0.0.0') })
  try {
    const code = await runImportHome(args, {
      home: io.home,
      profile: io.profile ?? 'default',
      env: io.env ?? {},
      deloBundles: ['@delo/bundle-local'],
      stdout: (text) => { out += text },
      ask: async (question) => { asked.push(question); return answers.shift() ?? '' },
      exclusive,
    })
    return { code, out, asked, error: undefined }
  } catch (error: unknown) {
    return { code: undefined, out, asked, error }
  }
}

/**
 * Store one attachment at the content address its bytes have, as upstream's object store does.
 * @param source - the stock home.
 * @param content - the attachment's bytes.
 * @returns its home-relative path.
 */
export function attachment(source: string, content: string): string {
  const digest = createHash('sha256').update(content).digest('hex')
  const path = `attachments/v1/objects/${digest.slice(0, 2)}/${digest}`
  put(source, path, content)
  return path
}

/** The text of the fixture's home patch: one plain row that lands, and one row on the sandbox that is held back. */
export const HOME_PATCH = '- id: ui-theme\n  config:\n    preference: dark\n- id: sandbox\n  config:\n    runnerCommand: /tmp/runner\n'

/**
 * A chat log as upstream's JSONL store writes it: a Session header and one finished turn, Zstandard-compressed.
 * @param id - the Session identifier, which names its directory.
 * @param cwd - its working folder, or `undefined` for a chat without one.
 * @param open - whether the log ends inside a turn.
 * @returns the generation's bytes.
 */
export function chatLog(id: string, cwd: string | undefined, open = false): Buffer {
  const header = { type: 'session', version: 4, id, createdAt: 0, isSeeded: false, delegationDepth: 0, ...cwd === undefined ? {} : { cwd } }
  const events = [{ type: 'turn/start', seq: 1 }, ...open ? [] : [{ type: 'turn/end', seq: 2 }]]
  return zstdCompressSync(Buffer.from(`${[header, ...events].map(record => JSON.stringify(record)).join('\n')}\n`))
}

/**
 * Write one chat into a stock home.
 * @param source - the stock home.
 * @param project - its project directory.
 * @param id - its Session identifier.
 * @param cwd - its working folder.
 * @param open - whether its log ends inside a turn.
 */
export function chat(source: string, project: string, id: string, cwd: string | undefined, open = false): void {
  put(source, `sessions/${project}/${id}/session.v4.jsonl.zstd`, chatLog(id, cwd, open))
}

/**
 * Shape a small stock home: two chats, an attachment, a workspace, a profile with one bundled and one third-party
 * plugin and a patch layer with one plain row and one expression, the home patch, the instructions, a skill, the key,
 * a key the import does not offer, and entries that stay behind.
 * @param source - the stock home.
 */
export function stockHome(source: string): void {
  chat(source, '--work--', 's1', '/work')
  chat(source, '_no-cwd', 's2', undefined)
  attachment(source, 'image')
  put(source, 'storages/workspace.json', `${JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: { w1: { path: '/work', title: 'work', sessionIds: ['s1'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } } })}\n`)
  put(source, 'profiles/web/package.json', `${JSON.stringify({ name: 'dsh-profile-web', private: true, scripts: { postinstall: 'touch pwned' }, dependencies: { 'third-party-plugin': '^1.0.0', 'local-plugin': 'file:/opt/local-plugin' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'third-party-plugin'] } } }, null, 2)}\n`)
  put(source, 'profiles/web/cordis.patch.yml', '- id: ui-chat\n  config:\n    linkOpening: new-tab\n- id: webapp\n  config:\n    port: !!js 3000 + 1\n')
  put(source, 'profiles/web/pnpm-workspace.yaml', 'packages:\n  - .\nallowBuilds:\n  evil-package: true\n')
  put(source, 'cordis.patch.yml', HOME_PATCH)
  put(source, 'AGENTS.md', '# notes\n')
  put(source, 'skills/review/SKILL.md', '---\nname: review\ndescription: Reviews a change\n---\n# review\n')
  put(source, '.credentials.yaml', `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${STOCK_SECRET}\n  OTHER_KEY: other-value\n`, 0o600)
  put(source, 'logs/startup.log', 'line\n')
}
