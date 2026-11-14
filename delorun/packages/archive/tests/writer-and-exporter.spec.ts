/**
 * Proves the export refuses to write what it cannot describe and the ZIP
 * writer refuses to write ambiguous containers: the secret scan names each kind
 * of secret and stops an unconfirmed export without an archive, a confirmed
 * export carries on, an export of another customisation schema version is
 * refused, and a writer refuses a second entry under one name. It also proves a
 * writer keeps a stored entry stored.
 */
import { describe, expect, it } from 'vitest'
import { ARCHIVE_CUSTOMISATION_SCHEMA_VERSION, type ArchiveCustomisation } from '@delorun/contract-archive-and-trash'
import { ZipArchive, ZipWriter, exportArchive, findSecrets, type ArchiveExportInput, type ExportWorkspace } from '../src/index.ts'
import { utf8 } from './support.ts'

/**
 * One workspace with one chat.
 * @param text - the chat's text.
 * @returns the workspace.
 */
function workspaceWith(text: string): ExportWorkspace {
  return { id: 'ws-1', name: 'Project', entity: utf8('{}'), chats: [{ id: 'chat-1', text }], attachments: [] }
}

/**
 * The input of an export of one workspace.
 * @param text - the chat's text.
 * @param extra - fields of the input to set.
 * @returns the input.
 */
function inputWith(text: string, extra: Partial<ArchiveExportInput> = {}): ArchiveExportInput {
  return {
    createdBy: 'delorun-archive-spec',
    origin: { homeKeyId: 'home-key', publicKey: Buffer.alloc(32, 7).toString('base64url') },
    workspaces: [workspaceWith(text)],
    customisation: { schemaVersion: ARCHIVE_CUSTOMISATION_SCHEMA_VERSION, rows: [] },
    exportedAt: '2026-01-01T00:00:00Z',
    ...extra,
  }
}

describe('the secret scan', () => {
  it.each([
    ['aws-access-key', 'key AKIAABCDEFGHIJKLMNOP here'],
    ['private-key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['github-token', 'ghp_abcdefghijklmnopqrstuvwxyz'],
    // Assembled at run time, so the repository's own secret scan does not read the fixture as a token.
    ['slack-token', ['xox', 'b-1234567890-abcdef'].join('')],
    ['api-key', 'sk-abcdefghijklmnopqrstuvwxyz'],
  ])('names a %s by kind and place and never by value', (kind, text) => {
    expect(findSecrets([workspaceWith(text)])).toEqual([{ workspaceId: 'ws-1', chatId: 'chat-1', kind }])
  })

  it('finds nothing in an ordinary chat', () => {
    expect(findSecrets([workspaceWith('hello')])).toEqual([])
  })
})

describe('exportArchive', () => {
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz'

  it('returns the findings and no archive when the person has not confirmed them', () => {
    const result = exportArchive(inputWith(secret))

    expect(result.cancelled).toBe(true)
    expect(result.bytes).toBeUndefined()
    expect(result.warnings).toEqual([{ workspaceId: 'ws-1', chatId: 'chat-1', kind: 'github-token' }])
  })

  it('writes the archive once the person confirms the findings', () => {
    const result = exportArchive(inputWith(secret, { confirmSecrets: true }))

    expect(result.cancelled).toBe(false)
    expect(result.warnings).toHaveLength(1)
    expect(ZipArchive.open(result.bytes!).names()).toContain('manifest.json')
  })

  it('stores chats with identical text as one chat object beside the workspace entity', () => {
    const workspace: ExportWorkspace = { ...workspaceWith('same text'), chats: [{ id: 'chat-1', text: 'same text' }, { id: 'chat-2', text: 'same text' }] }

    const archive = ZipArchive.open(exportArchive(inputWith('unused', { workspaces: [workspace] })).bytes!)

    expect(archive.names().filter(name => name.startsWith('objects/'))).toHaveLength(2)
  })

  it('refuses a customisation of another schema version', () => {
    const customisation: ArchiveCustomisation = JSON.parse('{"schemaVersion":99,"rows":[]}')

    expect(() => exportArchive(inputWith('hello', { customisation }))).toThrow('customisation schema version')
  })
})

describe('ZipWriter', () => {
  it('refuses a second entry under one name', () => {
    const writer = new ZipWriter()
    writer.add({ name: 'a.txt', bytes: utf8('x') })

    expect(() => writer.add({ name: 'a.txt', bytes: utf8('y') })).toThrow('holds the entry "a.txt" already')
  })

  it('stores an entry it was told to store even when deflating would be smaller', () => {
    const writer = new ZipWriter()
    writer.add({ name: 'a.txt', bytes: utf8('a'.repeat(1000)), method: 'store' })

    const [record] = ZipArchive.open(writer.finish()).entries

    expect(record!.method).toBe(0)
    expect(record!.compressedSize).toBe(1000)
  })
})
