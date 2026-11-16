/**
 * `delorun export` and `delorun import` over scratch homes. An export of a
 * chat or a workspace writes a signed archive that the same home imports as
 * verified and another home imports only after the person types the signing
 * key's fingerprint. Every hostile archive is refused before anything is
 * written outside the staging directory: a signature that does not verify, a
 * changed member, a path that leaves the destination, an absolute path, a
 * link member, a declared size smaller than the real one, a size bomb, an
 * entry or a file over the terminal's ceilings, and an unknown signer or an
 * unsigned archive without the person's typed confirmation. What Delorun checked
 * is printed before anything the archive states, and every archive-controlled
 * string is printed escaped. An import first finishes one a crash
 * interrupted, and neither command runs beside a live home process. An export
 * that finds a secret writes nothing until the person confirms. Each spec
 * fails when its check is removed.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { PUBLISHING_JOURNAL_SUFFIX, ZipArchive, ZipWriter, keyFingerprint, loadHomeKey, type ZipEntryInput } from '@delorun/archive'
import { acquireHomeLock, newStartId, runDirectory } from '@delorun/home'
import { sessionDirectoryPath } from '@delorun/trash'
import { CliError } from '../../src/exit.ts'
import { exportTarget, findChatDirectory, readChatText, runExport } from '../../src/export/index.ts'
import { withHomeExclusive } from '../../src/home-exclusion.ts'
import { IMPORT_MAX_FILE_BYTES, previewLines, runImport } from '../../src/import/index.ts'
import { main } from '../../src/main.ts'

const RUNTIME = brandString<RuntimeVersion>('0.0.0')

/**
 * The exclusion a command run takes over a home, with a probe every holder answers.
 * @param home - the home.
 * @param command - the command's name.
 * @returns the exclusion.
 */
function exclusiveOver(home: string, command: string): <T>(run: () => Promise<T>) => Promise<T> {
  return run => withHomeExclusive({ home, profile: 'default', command, instead: '' }, run, { probe: () => async () => 'answered', runtime: RUNTIME })
}

const scratch: string[] = []

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

/**
 * A fresh directory.
 * @param name - its prefix.
 * @returns its path.
 */
function fresh(name: string): string {
  const path = mkdtempSync(join(tmpdir(), `delorun-${name}-`))
  scratch.push(path)
  return path
}

/**
 * Plant one chat's newest session generation.
 * @param home - the home.
 * @param id - the chat.
 * @param text - the generation's text.
 * @param options - whether it is Zstandard-encoded.
 * @returns the session directory.
 */
function plantChat(home: string, id: string, text: string, options: { zstd?: boolean } = {}): string {
  const directory = sessionDirectoryPath(join(home, 'sessions'), '/work', id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'session.jsonl'), 'the oldest generation\n')
  if (options.zstd === true) writeFileSync(join(directory, 'session.v2.jsonl.zstd'), zstdCompressSync(Buffer.from(text)))
  else writeFileSync(join(directory, 'session.v2.jsonl'), text)
  writeFileSync(join(directory, 'session.lock'), '')
  return directory
}

/** One command run's output and questions. */
interface Run {
  readonly code: number
  readonly out: string
  readonly asked: readonly string[]
}

/**
 * Run `delorun export`.
 * @param home - the home.
 * @param args - the arguments after `export`.
 * @param answers - the answers, in order.
 * @returns the run.
 */
async function exporting(home: string, args: readonly string[], answers: readonly string[] = []): Promise<Run> {
  let out = ''
  const asked: string[] = []
  const queue = [...answers]
  const code = await runExport(args, { home, version: '0.1.0', stdout: (text) => { out += text }, ask: async (question) => { asked.push(question); return queue.shift() ?? '' }, exclusive: exclusiveOver(home, 'export') })
  return { code, out, asked }
}

/**
 * Run `delorun import`.
 * @param home - the home.
 * @param file - the archive.
 * @param answers - the answers, in order.
 * @returns the run.
 */
async function importing(home: string, file: string, answers: readonly string[] = []): Promise<Run> {
  let out = ''
  const asked: string[] = []
  const queue = [...answers]
  const code = await runImport([file], { home, stdout: (text) => { out += text }, ask: async (question) => { asked.push(question); return queue.shift() ?? '' }, exclusive: exclusiveOver(home, 'import') })
  return { code, out, asked }
}

/**
 * The refusal one run raises.
 * @param run - the run.
 * @returns the refusal.
 */
async function refusal(run: Promise<unknown>): Promise<CliError> {
  const error = await run.then(() => undefined, (failure: unknown) => failure)
  if (!(error instanceof CliError)) throw error instanceof Error ? error : new Error(`expected a CliError, got ${String(error)}`)
  return error
}

/**
 * What an import left under a home: the imported workspaces and anything in the staging directory.
 * @param home - the home.
 * @returns both listings, empty when the directories do not exist.
 */
function written(home: string): { readonly imported: string[], readonly staging: string[] } {
  const list = (path: string): string[] => existsSync(path) ? readdirSync(path) : []
  return { imported: list(join(home, 'archive', 'imported')), staging: list(join(home, 'archive', 'staging')) }
}

/**
 * Export one chat from a fresh home into a fresh file.
 * @param text - the chat's text.
 * @returns the exporting home and the archive's path.
 */
async function exportedChat(text = 'a chat the person wrote'): Promise<{ readonly home: string, readonly file: string }> {
  const home = fresh('home')
  plantChat(home, 'chat-a', text)
  const file = join(fresh('out'), 'chat.delorun')
  await exporting(home, ['chat-a', '--out', file])
  return { home, file }
}

/**
 * Rewrite one archive file entry by entry.
 * @param file - the archive.
 * @param change - each entry's replacement; the entry itself to keep it, `undefined` to drop it.
 * @param extra - entries to add.
 * @returns the rewritten archive's path.
 */
function rewrite(file: string, change: (entry: ZipEntryInput) => ZipEntryInput | undefined, extra: readonly ZipEntryInput[] = []): string {
  const archive = ZipArchive.open(readFileSync(file))
  const writer = new ZipWriter()
  for (const name of archive.names()) {
    const entry = change({ name, bytes: archive.read(name) })
    if (entry !== undefined) writer.add(entry)
  }
  for (const entry of extra) writer.add(entry)
  const out = join(fresh('hostile'), 'hostile.delorun')
  writeFileSync(out, writer.finish())
  return out
}

/** The name of the chat object in an exported chat archive. */
function chatObject(file: string, text: string): string {
  const archive = ZipArchive.open(readFileSync(file))
  return archive.names().find(name => new TextDecoder().decode(archive.read(name)) === text)!
}

describe('an exported archive', () => {
  it('imports into the same home as verified after one yes, and lists what it holds', async () => {
    const { home, file } = await exportedChat()
    const key = (await loadHomeKey(home))!

    const run = await importing(home, file, ['y'])

    expect(run.out.startsWith(`Signed by this home's key ${keyFingerprint(key.publicKey)}, which this home trusts.\nWhat the archive states about itself:\n`)).toBe(true)
    expect(run.out).toContain('"chat-a": 1 chat, 0 attachments')
    expect(run.out).toContain('Imported "chat-a" to archive/imported/chat-a.\n')
    expect(run.out).toContain('opening imported chats in the studio is not available yet')
    expect(run.asked).toHaveLength(1)
    expect(written(home).imported).toEqual(['chat-a'])
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('imports into another home only after the person types the signing key\'s fingerprint', async () => {
    const { home, file } = await exportedChat()
    const fingerprint = keyFingerprint((await loadHomeKey(home))!.publicKey)
    const other = fresh('other')

    const mistyped = await refusal(importing(other, file, ['not-the-fingerprint', 'y']))
    expect(mistyped.message).toContain('the fingerprint was not confirmed')
    expect(written(other)).toEqual({ imported: [], staging: [] })

    const declined = await refusal(importing(other, file, [fingerprint, 'n']))
    expect(declined.message).toContain('nothing was imported')
    expect(written(other)).toEqual({ imported: [], staging: [] })

    const run = await importing(other, file, [fingerprint, 'y'])
    expect(run.out.startsWith(`Signed by a key this home does not know, fingerprint ${fingerprint}.`)).toBe(true)
    expect(written(other).imported).toEqual(['chat-a'])

    const again = await importing(other, file, [fingerprint, 'yes'])
    expect(again.out).toMatch(/Imported "chat-a" to archive\/imported\/[0-9a-f-]{36}; the archive's identifier "chat-a" was taken\./)
  })

  it('carries a workspace with its Zstandard chats and the attachments they name', async () => {
    const home = fresh('home')
    const digest = 'a'.repeat(64)
    plantChat(home, 'chat-a', `{"attachment":"sha256:${digest}"}`, { zstd: true })
    plantChat(home, 'chat-b', 'the second chat')
    mkdirSync(join(home, 'attachments', 'v1', 'file-objects', 'aa'), { recursive: true })
    writeFileSync(join(home, 'attachments', 'v1', 'file-objects', 'aa', digest), 'attachment bytes')
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
      tables: { workspaces: { 'ws-1': { path: '/work/project', title: 'Project', sessionIds: ['chat-a', 'chat-b', 'chat-gone'] } } },
    }))
    const file = join(fresh('out'), 'project.delorun')

    const run = await exporting(home, ['ws-1', '--out', file])

    expect(run.out).toContain('"Project", 2 chats, 1 attachment')
    const imported = await importing(home, file, ['y'])
    expect(imported.out).toContain('"Project": 2 chats, 1 attachment')
  })
})

describe('the secret warning of an export', () => {
  it('writes nothing until the person confirms, and names each finding by kind', async () => {
    const home = fresh('home')
    plantChat(home, 'chat-a', 'my key is AKIAABCDEFGHIJKLMNOP')
    const file = join(fresh('out'), 'chat.delorun')

    const refused = await refusal(exporting(home, ['chat-a', '--out', file], ['n']))
    expect(refused.message).toContain('nothing was written')
    expect(existsSync(file)).toBe(false)

    const run = await exporting(home, ['chat-a', '--out', file], ['y'])
    expect(run.out).toContain('looks like 1 secret:')
    expect(run.out).toContain('aws-access-key in chat chat-a')
    expect(run.out).not.toContain('AKIAABCDEFGHIJKLMNOP')
    expect(run.asked[0]).toContain('Include them in the archive?')
    expect(existsSync(file)).toBe(true)
  })

  it('counts several findings, and exports a chat when the registry holds other workspaces', async () => {
    const home = fresh('home')
    plantChat(home, 'chat-a', 'AKIAABCDEFGHIJKLMNOP and -----BEGIN PRIVATE KEY-----')
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: { 'ws-1': { path: '/p', title: 'P', sessionIds: [] } } } }))

    const run = await exporting(home, ['chat-a', '--out', join(fresh('out'), 'chat.delorun')], ['y'])

    expect(run.out).toContain('looks like 2 secrets:')
  })
})

describe('the file an export writes', () => {
  it('never replaces an existing file', async () => {
    const home = fresh('home')
    plantChat(home, 'chat-a', 'text')
    const file = join(fresh('out'), 'chat.delorun')
    writeFileSync(file, 'kept')

    const refused = await refusal(exporting(home, ['chat-a', '--out', file]))

    expect(refused.message).toContain('exists')
    expect(readFileSync(file, 'utf8')).toBe('kept')
  })

  it('refuses an id that names neither a chat nor a workspace, and a wrong command line', async () => {
    const home = fresh('home')

    expect((await refusal(exporting(home, ['nothing', '--out', join(home, 'x.delorun')]))).message).toContain('no chat or workspace carries the id "nothing"')
    for (const args of [['--out', 'x'], ['a', 'b', '--out', 'x'], ['a'], ['a', '--out', ''], ['a', '--bogus']]) {
      expect((await refusal(exporting(home, args))).exit).toBe(2)
    }
  })

  it('refuses a workspace registry document it cannot read, and a damaged Zstandard chat', async () => {
    const home = fresh('home')
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(join(home, 'storages', 'workspace.json'), '{not json')
    expect((await refusal(exportTarget(home, 'ws-1'))).message).toContain('is not JSON')
    writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({ tables: {} }))
    expect((await refusal(exportTarget(home, 'ws-1'))).message).toContain('not one this version reads')

    const directory = sessionDirectoryPath(join(home, 'sessions'), '/work', 'chat-z')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'session.v1.jsonl.zstd'), 'not zstandard')
    expect((await refusal(readChatText(directory))).message).toContain('cannot be read')
  })

  it('reads nothing from a home without sessions, and skips a chat without a generation', async () => {
    const home = fresh('home')
    expect(await findChatDirectory(join(home, 'sessions'), 'chat-a')).toBeUndefined()
    const directory = sessionDirectoryPath(join(home, 'sessions'), '/work', 'chat-a')
    mkdirSync(directory, { recursive: true })
    expect(await readChatText(directory)).toBeUndefined()
    writeFileSync(join(home, 'sessions', 'stray-file'), '')
    expect(await findChatDirectory(join(home, 'sessions'), 'chat-b')).toBeUndefined()
  })
})

describe('a hostile archive', () => {
  it('with a signature that does not verify is refused, and nothing is written', async () => {
    const { home, file } = await exportedChat()
    const hostile = rewrite(file, entry => entry.name === 'manifest.json'
      ? { ...entry, bytes: new TextEncoder().encode(new TextDecoder().decode(entry.bytes).replace('"chat-a"', '"chat-b"')) }
      : entry)

    const refused = await refusal(importing(home, hostile, ['y']))

    expect(refused.message).toContain('ARCHIVE_SIGNATURE_INVALID')
    expect(written(home)).toEqual({ imported: [], staging: [] })
  })

  it('with a changed member is refused, and nothing is written', async () => {
    const { home, file } = await exportedChat('the original chat')
    const name = chatObject(file, 'the original chat')
    const hostile = rewrite(file, entry => entry.name === name ? { ...entry, bytes: new TextEncoder().encode('the altered chat!') } : entry)

    expect((await refusal(importing(home, hostile, ['y']))).message).toContain('ARCHIVE_CHECKSUM_MISMATCH')
    expect(written(home)).toEqual({ imported: [], staging: [] })
  })

  it.each([
    ['../escape', 'ARCHIVE_PATH_REJECTED'],
    ['objects/../../escape', 'ARCHIVE_PATH_REJECTED'],
    ['/etc/escape', 'ARCHIVE_PATH_REJECTED'],
  ])('with the member path %s is refused before anything is written', async (path, code) => {
    const { home, file } = await exportedChat()
    const hostile = rewrite(file, entry => entry, [{ name: path, bytes: new TextEncoder().encode('outside') }])

    expect((await refusal(importing(home, hostile, ['y']))).message).toContain(code)
    expect(written(home)).toEqual({ imported: [], staging: [] })
    expect(existsSync(join(home, 'escape'))).toBe(false)
  })

  it('with a symbolic link member is refused before anything is written', async () => {
    const { home, file } = await exportedChat('linked chat')
    const name = chatObject(file, 'linked chat')
    const hostile = rewrite(file, entry => entry.name === name ? { ...entry, unixMode: 0o120777 } : entry)

    expect((await refusal(importing(home, hostile, ['y']))).message).toContain('ARCHIVE_LINK_REJECTED')
    expect(written(home)).toEqual({ imported: [], staging: [] })
  })

  it('with a declared size smaller than the real size is refused', async () => {
    const { home, file } = await exportedChat('a chat whose size is understated')
    const name = chatObject(file, 'a chat whose size is understated')
    const hostile = rewrite(file, entry => entry.name === name ? { ...entry, declaredUncompressedSize: 4 } : entry)

    expect((await refusal(importing(home, hostile, ['y']))).message).toMatch(/ARCHIVE_TRUNCATED|ARCHIVE_RATIO_EXCEEDED/)
    expect(written(home)).toEqual({ imported: [], staging: [] })
  })

  it('that is a size bomb is refused on its declarations', async () => {
    const { home, file } = await exportedChat()
    const hostile = rewrite(file, entry => entry, [{ name: 'objects/bomb', bytes: new Uint8Array(4 * 1024 * 1024), method: 'deflate' }])

    expect((await refusal(importing(home, hostile, ['y']))).message).toContain('ARCHIVE_RATIO_EXCEEDED')
    expect(written(home)).toEqual({ imported: [], staging: [] })
  })

  it('that is unsigned imports only after the person types unverified, which a yes is not', async () => {
    const { home, file } = await exportedChat()
    const unsigned = rewrite(file, entry => entry.name === 'signature.json' ? undefined : entry)

    for (const answer of ['n', 'y', 'yes']) {
      expect((await refusal(importing(home, unsigned, [answer]))).message).toBe('delorun import: the unsigned archive was not accepted, so nothing was imported')
      expect(written(home)).toEqual({ imported: [], staging: [] })
    }

    const run = await importing(home, unsigned, ['unverified'])
    expect(run.out.startsWith('Not signed: nothing shows who made this archive or that it is unchanged.\n')).toBe(true)
    expect(run.asked).toEqual(['To import 1 workspace from this unsigned archive anyway, type unverified: '])
    expect(written(home).imported).toEqual(['chat-a'])
  })

  it('that is larger than the terminal imports is refused before it is read', async () => {
    const home = fresh('home')
    const file = join(fresh('big'), 'big.delorun')
    writeFileSync(file, '')
    truncateSync(file, IMPORT_MAX_FILE_BYTES + 1)

    expect((await refusal(importing(home, file, ['y']))).message).toContain(`more than the ${String(IMPORT_MAX_FILE_BYTES)} the terminal imports; nothing was read`)
    expect(written(home)).toEqual({ imported: [], staging: [] })
  })

  it('with an entry over the terminal\'s lower ceiling is refused on its declarations', async () => {
    const { home, file } = await exportedChat()
    const hostile = rewrite(file, entry => entry.name === 'signature.json' ? undefined : entry, [{
      name: 'objects/big',
      bytes: new TextEncoder().encode('small'),
      declaredUncompressedSize: 600 * 1024 * 1024,
      declaredCompressedSize: 20 * 1024 * 1024,
    }])

    expect((await refusal(importing(home, hostile, ['unverified']))).message).toContain('ARCHIVE_ENTRY_TOO_LARGE')
    expect(written(home)).toEqual({ imported: [], staging: [] })
  })

  it('whose text holds a control character is refused with the character escaped', async () => {
    const { home, file } = await exportedChat()
    const hostile = rewrite(file, entry => entry.name === 'signature.json' ? undefined : entry.name === 'manifest.json'
      ? { ...entry, bytes: new TextEncoder().encode(new TextDecoder().decode(entry.bytes).replace('"name": "chat-a"', '"name": "x\\u001b[2K\\rSigned by this home\'s key"')) }
      : entry)

    const refused = await refusal(importing(home, hostile, ['unverified']))

    expect(refused.message).toContain('ARCHIVE_SCHEMA_INVALID')
    expect(refused.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
  })

  it('that is not a regular file or does not exist is refused', async () => {
    const home = fresh('home')

    expect((await refusal(importing(home, home, ['y']))).message).toContain('is not a regular file')
    expect((await refusal(importing(home, join(home, 'missing.delorun'), ['y']))).message).toContain('cannot be read: ENOENT')
  })

  it('is never imported without a terminal to ask', async () => {
    const { home, file } = await exportedChat()

    expect((await refusal(importing(home, file))).message).toContain('nothing was imported')
    expect(written(home)).toEqual({ imported: [], staging: [] })
  })
})

describe('the preview an import shows', () => {
  it('prints the file name it was given escaped', async () => {
    const { home, file } = await exportedChat()
    const named = join(fresh('named'), 'evil\u001b[2K\u202e.delorun')
    writeFileSync(named, readFileSync(file))

    const run = await importing(home, named, ['y'])

    expect(run.out).toContain('File "evil\\u001b[2K\\u202e.delorun", written by "0.1.0"')
    expect(run.out).not.toMatch(/[\u001b\u202e]/)
  })

  it('escapes every archive-controlled field, after the line Delorun checked', () => {
    const lines = previewLines({
      state: 'unverified', reason: 'key-not-trusted', label: 'x', source: 'a\u009b.delorun', signed: true, createdBy: 'v\u2066', exportedAt: 't\u202e',
      signer: { declaredKeyId: 'k', publicKey: 'p', fingerprint: 'f' },
      workspaces: [{ id: 'a', name: 'A\u0085', chats: 1, attachments: 0 }],
      customisation: [{ kind: 'theme', target: 'dusk\u2028\u061c' }],
      totalBytes: 1,
    })

    expect(lines.split('\n')[0]).toBe('Signed by a key this home does not know, fingerprint f. Compare it with the fingerprint the sending home shows before you trust it.')
    expect(lines).toContain('File "a\\u009b.delorun", written by "v\\u2066" at "t\\u202e".')
    expect(lines).toContain('"A\\u0085": 1 chat, 0 attachments')
    expect(lines).toContain('theme "dusk\\u2028\\u061c"')
    expect(lines).not.toMatch(/[\u0085\u009b\u061c\u2028\u2066\u202e]/)
  })

  it('counts several workspaces and lists the customisation rows it will not apply', () => {
    const lines = previewLines({
      state: 'verified', label: 'verified', source: 'a.delorun', signed: true, createdBy: '0.1.0', exportedAt: '2026-01-01T00:00:00Z',
      signer: { declaredKeyId: 'k', publicKey: 'p', fingerprint: 'f' },
      workspaces: [{ id: 'a', name: 'A', chats: 2, attachments: 1 }, { id: 'b', name: 'B', chats: 1, attachments: 2 }],
      customisation: [{ kind: 'theme', target: 'dusk' }],
      totalBytes: 10,
    })

    expect(lines).toContain('  2 workspaces (10 bytes):')
    expect(lines).toContain('"A": 2 chats, 1 attachment')
    expect(lines).toContain('"B": 1 chat, 2 attachments')
    expect(lines).toContain('  Customisation it carries, listed and not applied:\n    theme "dusk"')
  })

  it('asks to import every workspace of an archive that holds several', async () => {
    const home = fresh('home')
    plantChat(home, 'chat-a', 'one')
    plantChat(home, 'chat-b', 'two')
    const first = join(fresh('out'), 'a.delorun')
    await exporting(home, ['chat-a', '--out', first])
    const archive = ZipArchive.open(readFileSync(first))
    const manifest = JSON.parse(new TextDecoder().decode(archive.read('manifest.json'))) as { workspaces: { id: string }[] }
    const doubled = rewrite(first, entry => entry.name === 'signature.json' ? undefined : entry.name === 'manifest.json'
      ? { ...entry, bytes: new TextEncoder().encode(JSON.stringify({ ...manifest, workspaces: [manifest.workspaces[0], { ...manifest.workspaces[0], id: 'chat-copy', name: 'copy' }] })) }
      : entry)

    const run = await importing(home, doubled, ['unverified'])

    expect(run.asked[0]).toContain('To import 2 workspaces from this unsigned archive anyway')
  })
})

describe('an import', () => {
  it('first finishes an import a crash interrupted, withdrawing what it published', async () => {
    const { home, file } = await exportedChat()
    mkdirSync(join(home, 'archive', 'imported', 'ws-orphan'), { recursive: true })
    mkdirSync(join(home, 'archive', 'staging', 'crashed', 'workspaces'), { recursive: true })
    writeFileSync(join(home, 'archive', 'staging', `crashed${PUBLISHING_JOURNAL_SUFFIX}`), JSON.stringify({ workspaces: ['ws-orphan'] }))

    const run = await importing(home, file, ['y'])

    expect(run.out.startsWith('Finished an import that was interrupted: withdrew the 1 workspace it had published and removed what it had staged.\n')).toBe(true)
    expect(written(home)).toEqual({ imported: ['chat-a'], staging: [] })
  })

  it('is refused while a home process runs, and writes nothing', async () => {
    const { home, file } = await exportedChat()
    const running = await acquireHomeLock({ runDirectory: runDirectory(home, 'default'), runtime: RUNTIME, probe: async () => 'answered', startId: newStartId() })
    try {
      expect((await refusal(importing(home, file, ['y']))).message).toContain('Delorun is running for the profile default')
      expect((await refusal(exporting(home, ['chat-a', '--out', join(fresh('out'), 'again.delorun')]))).message).toContain('Delorun is running for the profile default')
    } finally {
      running.release()
    }
    expect(written(home)).toEqual({ imported: [], staging: [] })
  })
})

describe('the stores an export reads', () => {
  it.skipIf(process.getuid?.() === 0)('report a store they cannot read rather than skip it', async () => {
    const home = fresh('home')
    mkdirSync(join(home, 'sessions', 'locked'), { recursive: true })
    chmodSync(join(home, 'sessions', 'locked'), 0)
    try {
      await expect(findChatDirectory(join(home, 'sessions'), 'chat-a')).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      chmodSync(join(home, 'sessions', 'locked'), 0o700)
    }
    mkdirSync(join(home, 'storages', 'workspace.json'), { recursive: true })
    await expect(exportTarget(home, 'ws-1')).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('report an attachment store that is not a directory, and an --out directory that does not exist', async () => {
    const home = fresh('home')
    plantChat(home, 'chat-a', `sha256:${'b'.repeat(64)}`)
    mkdirSync(join(home, 'attachments', 'v1'), { recursive: true })
    writeFileSync(join(home, 'attachments', 'v1', 'objects'), 'not a directory')
    await expect(exportTarget(home, 'chat-a')).rejects.toMatchObject({ code: 'ENOTDIR' })

    rmSync(join(home, 'attachments'), { recursive: true })
    await expect(exporting(home, ['chat-a', '--out', join(home, 'missing', 'chat.delorun')])).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('the command rows', () => {
  it('refuse a wrong import command line', async () => {
    const home = fresh('home')
    for (const args of [[], ['a', 'b'], ['a', '--bogus']]) {
      const error = await runImport(args, { home, stdout: () => undefined, ask: async () => '', exclusive: exclusiveOver(home, 'import') }).then(() => undefined, (failure: unknown) => failure)
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).exit).toBe(2)
    }
  })

  it('run export and import from the command table over the home the environment names, and ask nothing without a terminal', async () => {
    const home = fresh('home')
    plantChat(home, 'chat-a', 'text')
    const file = join(fresh('out'), 'chat.delorun')
    let err = ''
    const run = (argv: readonly string[]): Promise<number | undefined> => main(argv, { env: { DELORUN_HOME: home }, stdout: () => undefined, stderr: (text) => { err += text } })

    expect(await run(['export', 'chat-a', '--out', file, '--profile', 'default'])).toBe(0)
    expect(await run(['import', file])).toBe(1)
    expect(err).toContain('this needs you at a terminal to answer')
    expect(await run(['trash', 'restore', 'missing'])).toBe(1)
    expect(err).toContain('no trash item carries the id "missing"')
  })
})

describe('an import with no terminal to answer its question', () => {
  it('ends with one actionable line, never Node\'s unsettled top-level await warning', async () => {
    const { home, file } = await exportedChat()
    const unsigned = rewrite(file, entry => entry.name === 'signature.json' ? undefined : entry)
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(DSH_|DELORUN_|NODE_PATH$)/.test(name)))
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx/esm'), join(import.meta.dirname, '../../src/bin.ts'), 'import', unsigned], {
      env: { ...inherited, DELORUN_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('delorun import: this needs you at a terminal to answer; run it in one.')
    expect(result.stderr).not.toContain('unsettled top-level await')
    expect(written(home)).toEqual({ imported: [], staging: [] })
  })
})
