/**
 * The fixtures of the stock-home import specs: a scratch tree with a stock
 * home, a Delo home and a directory outside both, the writers that shape a
 * stock home, including its hostile variants, and the snapshot that proves a
 * home is byte-identical after an import: the path, content digest, permission
 * bits and inode of every entry.
 */
import { createHash } from 'node:crypto'
// spec-lanes-allow: `mkfifo` makes one named pipe for a refusal fixture in milliseconds; Node has no call that makes one
import { execFileSync } from 'node:child_process'
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { planDshHomeImport, type DshHomeImportPlan, type DshImportOptions } from '../src/dsh-import/index.ts'

/** One entry of a tree, as a snapshot records it. */
export interface SnapshotEntry {
  readonly path: string
  readonly digest: string
  readonly mode: number
}

/** A scratch tree holding one stock home, one Delo home and a directory outside both. */
export interface Homes {
  readonly root: string
  readonly source: string
  readonly target: string
  readonly outside: string
  /** Write one stock file, creating its directories. */
  write(path: string, content: string | Buffer, mode?: number): void
  /** Write one Delo home file, creating its directories. */
  writeTarget(path: string, content: string | Buffer, mode?: number): void
  /** Write one file outside both homes and return its absolute path. */
  writeOutside(path: string, content: string): string
  /** Create one stock directory. */
  directory(path: string): void
  /** Create one stock symbolic link. */
  link(path: string, to: string): void
  /** Create one stock hard link to an absolute path. */
  hardLink(path: string, to: string): void
  /** Create one stock named pipe. */
  fifo(path: string): void
  /** Remove the scratch tree. */
  remove(): void
}

/** The text of the stock key in the fixture; no spec output may contain it. */
export const FIXTURE_SECRET = 'sk-fixture-secret-0f7c'

/** The workspace list of the fixture: one workspace that owns the first chat. */
export function registry(workspaces: Record<string, { path: string, sessionIds: string[] }>, extra: Record<string, unknown> = {}): string {
  const records = Object.fromEntries(Object.entries(workspaces).map(([id, record]) => [id, { ...record, title: id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]))
  return `${JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: Object.keys(workspaces), archivedSessionIds: [], pinnedSessionIds: [], ...extra }, tables: { workspaces: records } }, null, 2)}\n`
}

/**
 * Create one scratch tree.
 * @returns the tree.
 */
export function makeHomes(): Homes {
  const root = mkdtempSync(join(tmpdir(), 'delo-dsh-import-'))
  const source = join(root, 'stock')
  const target = join(root, 'delo')
  const outside = join(root, 'outside')
  for (const directory of [source, target, outside]) mkdirSync(directory)
  const writeIn = (base: string) => (path: string, content: string | Buffer, mode = 0o644): void => {
    const file = join(base, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof content === 'string' ? asChatLog(path, content) : content, { mode })
  }
  return {
    root,
    source,
    target,
    outside,
    write: writeIn(source),
    writeTarget: writeIn(target),
    writeOutside(path, content) {
      writeIn(outside)(path, content)
      return join(outside, path)
    },
    directory(path) {
      mkdirSync(join(source, path), { recursive: true })
    },
    link(path, to) {
      mkdirSync(dirname(join(source, path)), { recursive: true })
      symlinkSync(to, join(source, path))
    },
    hardLink(path, to) {
      mkdirSync(dirname(join(source, path)), { recursive: true })
      linkSync(to, join(source, path))
    },
    fifo(path) {
      mkdirSync(dirname(join(source, path)), { recursive: true })
      execFileSync('mkfifo', [join(source, path)], { timeout: 30_000 })
    },
    remove() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** A chat generation's path: `sessions/<project>/<session>/session[.v<n>].jsonl.zstd`. */
const GENERATION = /^sessions\/([^/]+)\/([^/]+)\/session(?:\.v\d+)?\.jsonl\.zstd$/u

/**
 * The working folder a fixture's project directory stands for: `--work-proj--` is `/work/proj`, `_no-cwd` none.
 * @param project - the project directory's name.
 * @returns the folder, or `undefined` for `_no-cwd`.
 */
export function projectFolder(project: string): string | undefined {
  return project === '_no-cwd' ? undefined : `/${project.slice(2, -2).replaceAll('-', '/')}`
}

/**
 * A chat log as upstream's JSONL store writes it: Zstandard-compressed records, the Session header first.
 * @param id - the Session identifier.
 * @param cwd - the working folder, or `undefined` for none.
 * @param records - the records after the header.
 * @returns the compressed log.
 */
export function chatLog(id: string, cwd: string | undefined, records: readonly unknown[] = []): Buffer {
  const header = { type: 'session', version: 4, id, createdAt: 0, isSeeded: false, delegationDepth: 0, ...cwd === undefined ? {} : { cwd } }
  return zstdCompressSync(Buffer.from(`${[header, ...records].map(record => JSON.stringify(record)).join('\n')}\n`))
}

/**
 * The bytes a fixture writes: a text at a chat generation's path becomes a real log whose header matches its folder,
 * with the text as a record, so two texts give two logs; any other text is written as it is.
 * @param path - the home-relative path.
 * @param content - the text.
 * @returns the bytes.
 */
function asChatLog(path: string, content: string): string | Buffer {
  const match = GENERATION.exec(path)
  if (match === null) return content
  return chatLog(match[2] as string, projectFolder(match[1] as string), [{ type: 'note', text: content }])
}

/** The project directory of the fixture's first chat, as upstream's `projectKey` names `/work/proj`. */
export const PROJECT = '--work-proj--'

/**
 * The lowercase hexadecimal SHA-256 of a text.
 * @param content - the text.
 * @returns the digest.
 */
export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * The path upstream's attachment store gives one object.
 * @param store - `objects` or `file-objects`.
 * @param content - the object's bytes.
 * @returns `attachments/v1/<store>/<aa>/<digest>`.
 */
export function objectPath(store: 'objects' | 'file-objects', content: string): string {
  const digest = sha256(content)
  return `attachments/v1/${store}/${digest.slice(0, 2)}/${digest}`
}

/** The fixture's image attachment. */
export const IMAGE = objectPath('objects', 'image-bytes')

/** The fixture's file attachment object. */
export const FILE_OBJECT = objectPath('file-objects', 'file-bytes')

/** The fixture's named file attachment, an alias of {@link FILE_OBJECT}. */
export const FILE_ALIAS = `attachments/v1/files/${sha256('file-bytes').slice(0, 2)}/${sha256('file-bytes')}/report.pdf`

/**
 * Give a stock home the one entry that makes it a DeepSeek Harness home and nothing else: an empty workspace list.
 * @param homes - the scratch tree.
 */
export function mark(homes: Homes): void {
  homes.write('storages/workspace.json', registry({}))
}

/** A stock profile manifest. */
export function manifest(bundles: readonly string[], dependencies: Record<string, string> = {}, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies, dsh: { profile: { bundles } }, ...extra }, null, 2)}\n`
}

/**
 * Shape a stock home with an entry of every kind the import carries or leaves behind.
 * @param homes - the scratch tree.
 */
export function populate(homes: Homes): void {
  homes.write(`sessions/${PROJECT}/s1/session.v4.jsonl.zstd`, 'chat-one-generation-4')
  homes.write(`sessions/${PROJECT}/s1/session.v3.jsonl.zstd`, 'chat-one-generation-3')
  homes.write(`sessions/${PROJECT}/s1/session.lock`, '')
  homes.write('sessions/_no-cwd/s2/session.v4.jsonl.zstd', 'chat-two-generation-4')
  homes.write(IMAGE, 'image-bytes', 0o400)
  homes.write(FILE_OBJECT, 'file-bytes', 0o400)
  homes.hardLink(FILE_ALIAS, join(homes.source, FILE_OBJECT))
  homes.write('attachments/v1/request-images/ef/efgh', 'cache')
  homes.write('storages/workspace.json', registry({ w1: { path: '/work/proj', sessionIds: ['s1'] } }))
  homes.write('storages/session_projcache.json', '{}')
  homes.write('storages/schedule.json', '{}')
  homes.write('storages/cua_permissions_ab12.json', '{}')
  homes.write('profiles/web/package.json', manifest(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'third-party-bundle'], { 'third-party-bundle': '^1.0.0' }))
  homes.write('profiles/web/cordis.patch.yml', '- id: ui-chat\n  config:\n    linkOpening: new-tab\n')
  homes.write('profiles/web/compatibility.json', '{}\n')
  homes.write('profiles/web/pnpm-workspace.yaml', 'packages:\n  - .\nallowBuilds:\n  third-party-bundle: true\n')
  homes.write('profiles/web/pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
  homes.write('profiles/web/node_modules/third-party-bundle/package.json', '{}')
  homes.write('profiles/web/.plugin-manager/history/config', '[core]\n')
  homes.write('profiles/web/lock', '')
  homes.write('profiles/desktop/package.json', manifest(['@deepseek-ai/dsh-base']))
  homes.write('cordis.patch.yml', '[]\n')
  homes.write('settings.yaml', 'ui-chat: {}\n')
  homes.write('AGENTS.md', '# notes\n')
  homes.write('skills/review/SKILL.md', '---\nname: review\ndescription: Review a change\n---\n# review\n')
  homes.write('.credentials.yaml', `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${FIXTURE_SECRET}\n`, 0o600)
  homes.write('.env', 'X=1\n')
  homes.write('.anonymous-user-id', 'id\n')
  homes.write('logs/startup-1.log', 'line\n')
  homes.write('cache/models/list.json', '{}')
  homes.write('dsh-runtimes/0.2.0/bin', 'runtime')
  homes.write('spill/s1/out.txt', 'spilled')
  homes.write('runtimes/0.1.0/delorun', 'runtime')
  homes.write('mystery/file', 'unknown')
}

/** The options a spec plans with over its scratch tree. */
export function options(homes: Homes, overrides: Partial<DshImportOptions> = {}): DshImportOptions {
  return { sourceHome: homes.source, targetHome: homes.target, deloBundles: ['@delo/bundle-local'], ...overrides }
}

/**
 * Plan one import over the scratch tree.
 * @param homes - the tree.
 * @param overrides - the options to change.
 * @returns the plan.
 */
export function plan(homes: Homes, overrides: Partial<DshImportOptions> = {}): Promise<DshHomeImportPlan> {
  return planDshHomeImport(options(homes, overrides))
}

/**
 * Snapshot every entry of one tree.
 * @param root - the tree.
 * @returns each entry's path, content digest (`directory` or `link:<target>` where it has none) and permission bits.
 */
export function snapshot(root: string): readonly SnapshotEntry[] {
  const entries: SnapshotEntry[] = []
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const stats = lstatSync(path)
      const relativePath = relative(root, path)
      if (stats.isDirectory()) {
        entries.push({ path: relativePath, digest: 'directory', mode: stats.mode & 0o777 })
        walk(path)
      } else if (!stats.isFile()) {
        entries.push({ path: relativePath, digest: stats.isSymbolicLink() ? 'link' : 'special', mode: stats.mode & 0o777 })
      } else {
        entries.push({ path: relativePath, digest: createHash('sha256').update(readFileSync(path)).digest('hex'), mode: stats.mode & 0o777 })
      }
    }
  }
  walk(root)
  return entries
}

/**
 * The paths of a tree.
 * @param root - the tree.
 * @returns every relative path.
 */
export function paths(root: string): readonly string[] {
  return snapshot(root).map(entry => entry.path)
}

/**
 * Read one file of a tree.
 * @param root - the tree.
 * @param path - the relative path.
 * @returns its text.
 */
export function read(root: string, path: string): string {
  return readFileSync(join(root, path), 'utf8')
}
