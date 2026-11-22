import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOME_DATA_FORMAT_SCHEMA, DATA_FORMATS_FILE, DATA_FORMATS_SCHEMA, type DataFormats, type HomeDataFormat } from '@delorun/contract-update-report'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { acquireHomeLock, newStartId } from '@delorun/home'
import { StorePaths, type ReleaseFileBytes, type VerifiedRuntime } from '@delorun/runtime-store'
import { dataFormatsText, saveDataCopy, writeHomeDataFormat } from '@delorun/update'
import { fixtureKeys, fixtureRelease, nextRoot, type Fixture } from '../../install/tests/support.ts'
import { parseRepairLine, runRepair, type RepairChannel, type RepairLine, type RepairOptions, type RepairProgress, type RepairStore } from '../src/repair.ts'

const version = (text: string): RuntimeVersion => text as RuntimeVersion
const FORMATS: DataFormats = { schema: DATA_FORMATS_SCHEMA, persistence: 'c'.repeat(64) as DataFormats['persistence'], delorunRecords: { 'update-record': 1 } }
const record = (overrides: Partial<HomeDataFormat> = {}): HomeDataFormat => ({ schema: HOME_DATA_FORMAT_SCHEMA, delorun: '0.1.0', dsh: '0.2.2', formats: FORMATS, ...overrides })
const PLAIN: RepairLine = { restoreCopy: false, resetTrust: false }

/** Every regular file below a directory, by relative path, with its content hash. */
async function tree(directory: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {}
  if (!existsSync(directory)) return found
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) found[relative(directory, join(entry.parentPath, entry.name))] = createHash('sha256').update(await readFile(join(entry.parentPath, entry.name))).digest('hex')
  }
  return found
}

describe('delorun repair', () => {
  let home: string
  let fixture: Fixture
  let asked: string[]
  let out: string[]
  let err: string[]
  const NOW = new Date('2026-11-13T12:00:00Z')

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'delorun-repair-'))
    fixture = await fixtureRelease()
    asked = []
    out = []
    err = []
    for (const [path, text] of Object.entries({
      'runtimes/store.json': 'old store',
      'runtimes/0.1.0/marker': 'old program that fails its start check',
      'sessions/chat-1/log.jsonl': 'a chat',
      'storages/s.db': 'storage',
      'secrets/key': 'a secret',
      'settings.json': 'settings',
    })) {
      await mkdir(join(home, path, '..'), { recursive: true })
      await writeFile(join(home, path), text)
    }
    await mkdir(join(home, 'run'), { recursive: true })
    await mkdir(join(home, 'trust'), { recursive: true })
    await writeFile(join(home, 'trust/root.json'), fixture.roots[0]!, { mode: 0o600 })
    await writeFile(join(home, 'trust/timestamp.json'), fixture.timestampBytes, { mode: 0o600 })
    await writeHomeDataFormat(home, record())
  })
  afterEach(async () => { await rm(home, { recursive: true, force: true }) })

  function options(overrides: { line?: RepairLine, answer?: boolean | undefined, install?: RepairStore['install'], startCheck?: RepairOptions['startCheck'], release?: string, dsh?: string, formats?: DataFormats | undefined, installed?: string, roots?: readonly Uint8Array[] } = {}): RepairOptions {
    const paths = new StorePaths(home, 'linux-x64')
    const target = version(overrides.release ?? '0.1.1')
    const store: RepairStore = {
      paths,
      pointers: () => Promise.resolve({ current: version(overrides.installed ?? '0.1.0') }),
      install: overrides.install ?? (async () => {
        await mkdir(paths.version(target), { recursive: true })
        if (overrides.formats !== undefined || !('formats' in overrides)) await writeFile(join(paths.version(target), DATA_FORMATS_FILE), dataFormatsText(overrides.formats ?? FORMATS))
        await writeFile(join(paths.root, 'store.json'), 'fresh store')
        return { version: target, manifest: { dsh: overrides.dsh ?? '0.2.2' } } as VerifiedRuntime
      }),
    }
    const channel: RepairChannel = {
      resolve: () => Promise.resolve({ version: target, root: fixture.rootMetadata }),
      fill: () => Promise.reject(new Error('the fake store does not fill')),
      recordInstalled: () => Promise.resolve(),
    }
    return {
      home, profile: 'default', line: overrides.line ?? PLAIN, roots: overrides.roots ?? fixture.roots, store, channel,
      confirm: (question) => { asked.push(question); return Promise.resolve('answer' in overrides ? overrides.answer : true) },
      startCheck: overrides.startCheck ?? (() => Promise.resolve()),
      output: { stdout: text => void out.push(text), stderr: text => void err.push(text) },
      now: () => NOW, releaseChannel: 'stable', repairMarkGraceSeconds: 5,
    }
  }

  async function unchangedData(): Promise<Record<string, Record<string, string>>> {
    return { sessions: await tree(join(home, 'sessions')), storages: await tree(join(home, 'storages')), secrets: await tree(join(home, 'secrets')), trust: await tree(join(home, 'trust')), settings: await tree(home).then(files => ({ 'settings.json': files['settings.json']! })) }
  }

  it('installs into a fresh store, sets the old store aside whole, and leaves chats, secrets, settings and trust byte-identical', async () => {
    const before = await unchangedData()
    const oldStore = await tree(join(home, 'runtimes'))
    expect(await runRepair(options())).toBe(0)
    expect(await unchangedData()).toEqual(before)
    expect(await tree(join(home, 'runtimes.set-aside-20261113T120000Z'))).toEqual(oldStore)
    expect(await readFile(join(home, 'runtimes/store.json'), 'utf8')).toBe('fresh store')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('Replace the installed program 0.1.0 with 0.1.1?')
    expect(out.join('')).toContain('runtimes.set-aside-20261113T120000Z')
    expect(out.join('')).toContain('delorun recover discard runtimes.set-aside-20261113T120000Z')
  })

  it('tells the install display of the steps it reports itself, then ends it with what to do next', async () => {
    const events: string[] = []
    const progress: RepairProgress = { handle: (event) => { events.push(event.step) }, finish: (next) => { events.push(`finish: ${next}`) }, fail: () => { events.push('fail') } }
    const base = options()
    const install = base.store.install.bind(base.store)
    const channel: RepairChannel = { ...base.channel, fill: () => Promise.resolve({} as ReleaseFileBytes) }
    const store: RepairStore = { ...base.store, install: async (request) => { await request.fill(join(home, 'staging')); return install(request) } }
    expect(await runRepair({ ...base, store, channel, progress })).toBe(0)
    expect(events).toEqual(['installing', 'installed', 'finish: start Delorun with: delorun'])
  })

  it('marks the install display failed when the repair stops, and ends it with no next step', async () => {
    const events: string[] = []
    const progress: RepairProgress = { handle: (event) => { events.push(event.step) }, finish: (next) => { events.push(`finish: ${next}`) }, fail: () => { events.push('fail') } }
    expect(await runRepair({ ...options({ answer: false }), progress })).toBe(1)
    expect(events).toEqual(['fail'])
  })

  it('writes one redacted record per run to logs/repair.log at mode 0600', async () => {
    await runRepair(options())
    await runRepair(options({ answer: false }))
    const lines = (await readFile(join(home, 'logs/repair.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines.map(line => line.outcome)).toEqual(['repaired', 'refused'])
    expect(lines[0]).toMatchObject({ command: 'repair', versions: { installed: '0.1.0', target: '0.1.1' } })
    expect((await stat(join(home, 'logs/repair.log'))).mode & 0o777).toBe(0o600)
  })

  it('refuses while a home process runs, names delorun stop, and moves nothing', async () => {
    await mkdir(join(home, 'run/default'), { recursive: true })
    const lock = await acquireHomeLock({ runDirectory: join(home, 'run/default'), runtime: version('0.1.0'), probe: () => Promise.resolve('answered'), startId: newStartId() })
    try {
      const before = await tree(home)
      expect(await runRepair(options())).toBe(1)
      expect(err.join('')).toContain('HOME_RUNNING')
      expect(err.join('')).toContain('delorun stop')
      expect(asked).toEqual([])
      const after = await tree(home)
      delete after['logs/repair.log']
      expect(after).toEqual(before)
    } finally {
      lock.release()
    }
  })

  it('holds the home lock from before the set-aside to the end, so a start racing the repair is refused and never reads the set-aside store', async () => {
    await mkdir(join(home, 'run/default'), { recursive: true })
    const attempts: string[] = []
    const race = async (when: string): Promise<void> => {
      const outcome = await acquireHomeLock({ runDirectory: join(home, 'run/default'), runtime: version('0.1.0'), probe: () => Promise.resolve('silent'), startId: newStartId() }).then(
        (lock) => { lock.release(); return 'started' },
        (error: unknown) => (error as { code?: string }).code ?? 'failed')
      attempts.push(`${when}: ${outcome}`)
    }
    const base = options()
    const confirm = base.confirm
    expect(await runRepair({
      ...base,
      confirm: async (question) => { await race('before the set-aside'); return confirm(question) },
      startCheck: async () => {
        await race('after the set-aside')
        expect((await readdir(home)).some(name => name.startsWith('runtimes.set-aside-'))).toBe(true)
      },
    })).toBe(0)
    expect(attempts).toEqual(['before the set-aside: HOME_UNRESPONSIVE', 'after the set-aside: HOME_UNRESPONSIVE'])
    await race('after the repair')
    expect(attempts.at(-1)).toBe('after the repair: started')
  })

  it('releases the home lock when the repair refuses', async () => {
    await mkdir(join(home, 'run/default'), { recursive: true })
    expect(await runRepair(options({ answer: false }))).toBe(1)
    const lock = await acquireHomeLock({ runDirectory: join(home, 'run/default'), runtime: version('0.1.0'), probe: () => Promise.resolve('silent'), startId: newStartId() })
    lock.release()
  })

  it('refuses without a terminal and when the person declines, moving nothing', async () => {
    const before = await tree(join(home, 'runtimes'))
    expect(await runRepair(options({ answer: undefined }))).toBe(1)
    expect(err.join('')).toContain('NO_TERMINAL')
    expect(await runRepair(options({ answer: false }))).toBe(1)
    expect(await tree(join(home, 'runtimes'))).toEqual(before)
    expect(existsSync(join(home, 'runtimes.set-aside-20261113T120000Z'))).toBe(false)
  })

  it('renames the old store back when the install fails midway', async () => {
    const before = await unchangedData()
    const oldStore = await tree(join(home, 'runtimes'))
    expect(await runRepair(options({ install: () => Promise.reject(new Error('the disk filled')) }))).toBe(1)
    expect(await tree(join(home, 'runtimes'))).toEqual(oldStore)
    expect(await unchangedData()).toEqual(before)
    expect((await readdir(home)).filter(name => name.startsWith('runtimes.'))).toEqual([])
  })

  it('renames the old store back when the new release fails its start check', async () => {
    const oldStore = await tree(join(home, 'runtimes'))
    expect(await runRepair(options({ startCheck: () => Promise.reject(new Error('a file changed')) }))).toBe(1)
    expect(await tree(join(home, 'runtimes'))).toEqual(oldStore)
    expect((await readdir(home)).filter(name => name.startsWith('runtimes.'))).toEqual([])
  })

  it('refuses an older release on newer data, offers the way forward and the copy, and puts the old store back', async () => {
    await writeHomeDataFormat(home, record({ delorun: '0.2.0', dsh: '0.3.0' }))
    const oldStore = await tree(join(home, 'runtimes'))
    expect(await runRepair(options({ release: '0.1.1' }))).toBe(1)
    const text = err.join('')
    expect(text).toContain("Delorun did not repair: release 0.1.1 may not read this home's chats, which Delorun 0.2.0 wrote.")
    expect(text).toContain('npx delorun@latest repair --release 0.1.1 --restore-copy')
    expect(await tree(join(home, 'runtimes'))).toEqual(oldStore)
  })

  it('treats a home with no record as unknown and goes on, saying so', async () => {
    await rm(join(home, 'data-format.json'))
    expect(await runRepair(options())).toBe(0)
    expect(out.join('')).toContain('no data-format record')
    expect(out.join('')).toContain('assumes they are in the formats release 0.1.1 reads')
  })

  it('puts the copy back with --restore-copy, setting today\'s chats aside', async () => {
    await saveDataCopy({ home, from: '0.1.0', to: '0.2.0', formats: { from: FORMATS, to: FORMATS }, now: new Date('2026-11-01T00:00:00Z') })
    await writeFile(join(home, 'sessions/chat-1/log.jsonl'), 'a chat, continued under 0.2.0')
    await writeHomeDataFormat(home, record({ delorun: '0.2.0', dsh: '0.3.0' }))
    expect(await runRepair(options({ line: { ...PLAIN, restoreCopy: true } }))).toBe(0)
    expect(await readFile(join(home, 'sessions/chat-1/log.jsonl'), 'utf8')).toBe('a chat')
    const asides = await readdir(join(home, 'data-set-aside'))
    expect(asides).toHaveLength(1)
    expect(await readFile(join(home, 'data-set-aside', asides[0]!, 'sessions/chat-1/log.jsonl'), 'utf8')).toBe('a chat, continued under 0.2.0')
    expect(asked[0]).toContain("today's chats are set aside")
    expect(JSON.parse(await readFile(join(home, 'data-format.json'), 'utf8'))).toMatchObject({ delorun: '0.1.0', dsh: '0.2.2' })
  })

  it('refuses --restore-copy when the home keeps no copy for the release that wrote the data', async () => {
    await writeHomeDataFormat(home, record({ delorun: '0.2.0', dsh: '0.3.0' }))
    expect(await runRepair(options({ line: { ...PLAIN, restoreCopy: true } }))).toBe(1)
    expect(err.join('')).toContain('keeps no chat-data copy for Delorun 0.2.0')
    expect(await readFile(join(home, 'sessions/chat-1/log.jsonl'), 'utf8')).toBe('a chat')
  })

  it('refuses when the home has a record and the release\'s data formats cannot be read, naming what could not be read', async () => {
    const oldStore = await tree(join(home, 'runtimes'))
    expect(await runRepair(options({ formats: undefined }))).toBe(1)
    expect(err.join('')).toContain('DATA_UNREADABLE')
    expect(err.join('')).toContain('release 0.1.1 has no readable data-formats.json')
    expect(await tree(join(home, 'runtimes'))).toEqual(oldStore)
  })

  it('refuses when the release names a DSH version that is not a version, and when the home\'s record does', async () => {
    expect(await runRepair(options({ dsh: 'next' }))).toBe(1)
    expect(err.join('')).toMatch(/DATA_UNREADABLE.*release 0\.1\.1 names DSH version next/su)
    err.length = 0
    await writeHomeDataFormat(home, record({ dsh: 'latest' }))
    expect(await runRepair(options())).toBe(1)
    expect(err.join('')).toMatch(/DATA_UNREADABLE.*the home's record names DSH version latest/su)
  })

  it('names --from in the copy remedy when the named release is below the floor', async () => {
    await writeHomeDataFormat(home, record({ delorun: '0.2.0', dsh: '0.3.0' }))
    const line = { ...PLAIN, release: version('0.1.0'), from: '/downloads/delorun-0.1.0' }
    expect(await runRepair(options({ release: '0.1.0', installed: '0.2.0', line }))).toBe(1)
    expect(err.join('')).toContain('--release 0.1.0 --restore-copy --from /downloads/delorun-0.1.0')
  })

  it('refuses --restore-copy when the copy holds formats newer than the release reads, and puts the old store back', async () => {
    const newer: DataFormats = { ...FORMATS, delorunRecords: { 'update-record': 2 } }
    await saveDataCopy({ home, from: '0.2.0', to: '0.3.0', formats: { from: newer, to: newer }, now: new Date('2026-11-01T00:00:00Z') })
    await writeHomeDataFormat(home, record({ delorun: '0.3.0', dsh: '0.4.0', formats: newer }))
    const oldStore = await tree(join(home, 'runtimes'))
    expect(await runRepair(options({ line: { ...PLAIN, restoreCopy: true } }))).toBe(1)
    expect(err.join('')).toContain('DATA_COPY_NEWER')
    expect(await tree(join(home, 'runtimes'))).toEqual(oldStore)
    expect(await readFile(join(home, 'sessions/chat-1/log.jsonl'), 'utf8')).toBe('a chat')
    expect(JSON.parse(await readFile(join(home, 'data-format.json'), 'utf8'))).toMatchObject({ delorun: '0.3.0' })
  })

  it('refuses --restore-copy when the copy\'s own formats were unreadable', async () => {
    await saveDataCopy({ home, from: '0.1.0', to: '0.2.0', formats: { from: undefined, to: FORMATS }, now: new Date('2026-11-01T00:00:00Z') })
    await writeHomeDataFormat(home, record({ delorun: '0.2.0', dsh: '0.3.0' }))
    expect(await runRepair(options({ line: { ...PLAIN, restoreCopy: true } }))).toBe(1)
    expect(err.join('')).toContain('DATA_COPY_NEWER')
  })

  it('refuses a release below the floor that only the stored timestamp sets', async () => {
    expect(await runRepair(options({ release: '0.0.9', installed: '0.0.5' }))).toBe(1)
    expect(err.join('')).toContain('TARGET_LOWER')
    expect(err.join('')).toContain('release 0.1.0')
  })

  it('installs a release the person named below the floor from --from only after an extra yes, and refuses without a terminal', async () => {
    const line = { ...PLAIN, release: version('0.1.0'), from: '/downloads/delorun-0.1.0' }
    expect(await runRepair(options({ release: '0.1.0', installed: '0.2.0', line, answer: undefined }))).toBe(1)
    expect(err.join('')).toContain('NO_TERMINAL')
    expect(await readFile(join(home, 'runtimes/store.json'), 'utf8')).toBe('old store')
    asked.length = 0
    err.length = 0
    expect(await runRepair(options({ release: '0.1.0', installed: '0.2.0', line }))).toBe(0)
    expect(asked[0]).toMatch(/Release 0\.1\.0 is older than release 0\.2\.0.*you named it/su)
    expect(asked).toHaveLength(2)
  })

  it('does not ask twice when the channel already asked about the floor', async () => {
    const line = { ...PLAIN, release: version('0.1.0'), from: '/downloads/delorun-0.1.0' }
    expect(await runRepair({ ...options({ release: '0.1.0', installed: '0.2.0', line }), belowFloorAsked: () => true })).toBe(0)
    expect(asked).toHaveLength(1)
  })

  it('refuses a release below the highest the home has installed, and points at rollback', async () => {
    expect(await runRepair(options({ release: '0.1.0', installed: '0.2.0' }))).toBe(1)
    expect(err.join('')).toContain('TARGET_LOWER')
    expect(err.join('')).toContain('delorun recover rollback')
    expect(asked).toEqual([])
  })

  describe('--reset-trust', () => {
    const resetLine: RepairLine = { ...PLAIN, resetTrust: true }

    it('is refused, before any prompt, when the launcher\'s shipped chain is not newer than the stored root', async () => {
      const before = await tree(join(home, 'trust'))
      expect(await runRepair(options({ line: resetLine }))).toBe(1)
      expect(err.join('')).toContain('RESET_TRUST_REFUSED')
      expect(asked).toEqual([])
      expect(await tree(join(home, 'trust'))).toEqual(before)
    })

    it('is refused when the stored root still chains from a shipped root', async () => {
      const keys = fixtureKeys()
      const second = nextRoot(fixture.rootMetadata, keys, [keys.root])
      expect(await runRepair(options({ line: resetLine, roots: [fixture.roots[0]!, second] }))).toBe(1)
      expect(err.join('')).toContain('RESET_TRUST_REFUSED')
    })

    it('moves trust aside after the npm-anchor prompt when the shipped chain is newer and the stored root does not chain', async () => {
      const other = await fixtureRelease()
      const shipped = [fixture.roots[0]!, nextRoot(fixture.rootMetadata, fixture.keys, [fixture.keys.root])]
      await writeFile(join(home, 'trust/root.json'), other.roots[0]!, { mode: 0o600 })
      const stored = await tree(join(home, 'trust'))
      expect(await runRepair(options({ line: resetLine, roots: shipped }))).toBe(0)
      expect(asked[0]).toContain('installed it with npx delorun@latest from npm yourself')
      expect(await tree(join(home, 'trust.set-aside-20261113T120000Z'))).toEqual(stored)
      expect(existsSync(join(home, 'trust'))).toBe(true)
    })
  })

  describe('--reset-trust and the repair mark', () => {
    it('names the trust folder in the mark before the download, so a killed repair can be put back', async () => {
      const other = await fixtureRelease()
      const shipped = [fixture.roots[0]!, nextRoot(fixture.rootMetadata, fixture.keys, [fixture.keys.root])]
      await writeFile(join(home, 'trust/root.json'), other.roots[0]!, { mode: 0o600 })
      let mark: { setAside?: string, trustSetAside?: string } | undefined
      const paths = new StorePaths(home, 'linux-x64')
      const install: RepairStore['install'] = async () => {
        mark = JSON.parse(await readFile(join(home, 'run/repair.json'), 'utf8')) as typeof mark
        await mkdir(paths.version(version('0.1.1')), { recursive: true })
        await writeFile(join(paths.version(version('0.1.1')), DATA_FORMATS_FILE), dataFormatsText(FORMATS))
        return { version: version('0.1.1'), manifest: { dsh: '0.2.2' } } as VerifiedRuntime
      }
      expect(await runRepair(options({ line: { ...PLAIN, resetTrust: true }, roots: shipped, install }))).toBe(0)
      expect(mark).toMatchObject({ setAside: join(home, 'runtimes.set-aside-20261113T120000Z'), trustSetAside: join(home, 'trust.set-aside-20261113T120000Z') })
    })
  })

  describe('--reset-trust with a stored chain that cannot be read', () => {
    it('keeps the gate shut and moves nothing, naming the by-hand steps', async () => {
      const other = await fixtureRelease()
      const shipped = [fixture.roots[0]!, nextRoot(fixture.rootMetadata, fixture.keys, [fixture.keys.root])]
      await writeFile(join(home, 'trust/root.json'), other.roots[0]!, { mode: 0o600 })
      await mkdir(join(home, 'trust/roots'), { mode: 0o700 })
      await writeFile(join(home, 'trust/roots/2.root.json'), 'not a root', { mode: 0o600 })
      const before = await tree(join(home, 'trust'))
      expect(await runRepair(options({ line: { ...PLAIN, resetTrust: true }, roots: shipped }))).toBe(1)
      expect(err.join('')).toContain('RESET_TRUST_REFUSED')
      expect(err.join('')).toContain('by hand')
      expect(asked).toEqual([])
      expect(await tree(join(home, 'trust'))).toEqual(before)
      expect(existsSync(join(home, 'trust.set-aside-20261113T120000Z'))).toBe(false)
    })
  })

  describe('reach', () => {
    it('is not a request the home process takes, and no module of the home process or its sockets imports the repair', async () => {
      const root = join(import.meta.dirname, '../../..')
      const contract = await readFile(join(root, 'packages/contract-home-process/src/index.ts'), 'utf8')
      expect(contract).not.toMatch(/repair|restore-copy|reset-trust/iu)
      expect(await readFile(join(root, 'apps/npm-launcher/src/index.ts'), 'utf8')).not.toMatch(/repair/iu)
      for (const directory of ['packages/home-process/src', 'packages/home/src', 'apps/cli/src']) {
        for (const entry of await readdir(join(root, directory), { recursive: true, withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
          expect(await readFile(join(entry.parentPath, entry.name), 'utf8'), join(entry.parentPath, entry.name)).not.toMatch(/runRepair|parseRepairLine|npm-launcher\/src\/repair/u)
        }
      }
    })
  })
})

describe('the repair command line', () => {
  it('reads its flags and refuses anything else', () => {
    expect(parseRepairLine(['repair', '--profile', 'x', '--from', '/tmp/r', '--restore-copy', '--reset-trust'], version('0.1.0'))).toEqual({ restoreCopy: true, resetTrust: true, release: '0.1.0', from: '/tmp/r' })
    expect(parseRepairLine(['repair', '--from=https://example.test/r'], undefined)).toEqual({ restoreCopy: false, resetTrust: false, from: 'https://example.test/r' })
    expect(() => parseRepairLine(['repair', '--yes'], undefined)).toThrow(/not --yes/u)
    expect(() => parseRepairLine(['repair', '--from'], undefined)).toThrow(/--from needs/u)
  })
})
