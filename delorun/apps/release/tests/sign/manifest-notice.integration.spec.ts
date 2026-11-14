/**
 * The release manifest's notice fields, `security` and `summary`: a reader accepts a manifest without them, as a reader
 * sees no security marker and no summary there, and refuses a summary a terminal or the studio could not print as one
 * plain line, a summary that is not valid Unicode, a summary above the length limit and a `security` that is not a
 * boolean. Signing refuses a draft with a lone surrogate in its summary as well.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isValidNotes, isValidSummary, RELEASE_FILE_SIZE_LIMITS, RELEASE_SUMMARY_MAX_LENGTH, type ReleaseManifest } from '@delorun/contract-release-manifest'
import { MANIFEST_DRAFT_NAME } from '../../src/sign/release.ts'
import { ManifestSchema } from '@delorun/release-formats/sign/schemas'
import { manifestContent, releaseFixture } from './fixture.ts'

/** A manifest the fixture builds, with its notice fields replaced or removed. */
function manifest(fields: Record<string, unknown>, remove: readonly string[] = []): Record<string, unknown> {
  const content: Record<string, unknown> = { ...manifestContent('0.1.0', Buffer.from('archive')), ...fields }
  for (const field of remove) delete content[field]
  return content
}

/** The signing case builds a fixture release, which a loaded host slows. */
const FIXTURE_TIMEOUT = { timeout: 60_000 }

describe('the manifest\'s notice fields', () => {
  it('c02-summary-control-characters-refused: a reader refuses a summary holding an escape, a newline or a right-to-left override', () => {
    for (const summary of ['Fixes \u001b[31mred\u001b[0m text', 'Two\nlines', 'Fixes ‮evil.exe']) {
      expect(ManifestSchema.safeParse(manifest({ summary })).success, JSON.stringify(summary)).toBe(false)
      expect(isValidSummary(summary)).toBe(false)
    }
  })

  it('c02-summary-lone-surrogate-refused: a reader and signing refuse a summary holding a lone high or low surrogate, and accept a surrogate pair', FIXTURE_TIMEOUT, async (test) => {
    const lone = ['Fixes \uD83D alone', 'Fixes \uDD12 alone', 'Ends high \uD83D', '\uDD12 starts low', 'Reversed \uDD12\uD83D pair']
    for (const summary of lone) {
      expect(isValidSummary(summary), JSON.stringify(summary)).toBe(false)
      expect(ManifestSchema.safeParse(manifest({ summary })).success, JSON.stringify(summary)).toBe(false)
    }
    expect(isValidSummary('Locks \uD83D\uDD12 the door')).toBe(true)
    expect(ManifestSchema.safeParse(manifest({ summary: 'Locks \uD83D\uDD12 the door' })).success).toBe(true)
    const fixture = await releaseFixture(test)
    const path = join(fixture.release, MANIFEST_DRAFT_NAME)
    const draft = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    for (const summary of lone) {
      writeFileSync(path, `${JSON.stringify({ ...draft, summary }, undefined, 2)}\n`)
      const result = await fixture.sign()
      expect(result.stderr, JSON.stringify(summary)).toContain('a release summary: 1 to 200 characters, no control, format, line-break or lone surrogate character')
      expect(result.status).toBe(1)
      expect(existsSync(join(fixture.release, `delorun-${fixture.version}.manifest.json`))).toBe(false)
    }
  })

  it('c02-summary-too-long-refused: a reader refuses a summary above the limit, counted in code points', () => {
    expect(RELEASE_SUMMARY_MAX_LENGTH).toBe(200)
    expect(ManifestSchema.safeParse(manifest({ summary: 'x'.repeat(RELEASE_SUMMARY_MAX_LENGTH + 1) })).success).toBe(false)
    expect(ManifestSchema.safeParse(manifest({ summary: 'x'.repeat(RELEASE_SUMMARY_MAX_LENGTH) })).success).toBe(true)
    expect(isValidSummary('\u{1F512}'.repeat(RELEASE_SUMMARY_MAX_LENGTH))).toBe(true)
    expect(isValidSummary('\u{1F512}'.repeat(RELEASE_SUMMARY_MAX_LENGTH + 1))).toBe(false)
  })

  it('c02-security-not-boolean-refused: a reader refuses a security marker that is not a boolean', () => {
    for (const security of ['true', 1, null]) expect(ManifestSchema.safeParse(manifest({ security })).success, String(security)).toBe(false)
    expect(ManifestSchema.safeParse(manifest({ security: true })).success).toBe(true)
  })

  it('c02-manifest-without-notice-fields-reads: a manifest without both fields reads, with no security marker and no summary', () => {
    const parsed: ReleaseManifest = ManifestSchema.parse(manifest({}, ['security', 'summary']))
    expect(parsed.security ?? false).toBe(false)
    expect(parsed.summary).toBeUndefined()
    expect('security' in parsed || 'summary' in parsed).toBe(false)
  })

  it('accepts a summary only when it is one plain line with no whitespace at either end', () => {
    expect(isValidSummary('Fixes a crash when a workspace path holds a newline.')).toBe(true)
    expect(isValidSummary('Ünïcode and 日本語 are plain text')).toBe(true)
    for (const summary of ['', ' ', '   ', ' leading', 'trailing ', 'tab\there', 'line separator', 'paragraph separator', 'zero​width', 'bom﻿', 'carriage\rreturn', 'nul\u0000']) {
      expect(isValidSummary(summary), JSON.stringify(summary)).toBe(false)
    }
  })
})

describe('the manifest\'s notes reference', () => {
  const notes = (length: number) => ({ name: 'delorun-0.1.0.notes.txt', length, sha256: 'a'.repeat(64) })

  it('c02-manifest-without-notes-reads: a manifest without a notes reference reads and names no notes', () => {
    expect(ManifestSchema.parse(manifest({}, ['notes'])).notes).toBeUndefined()
  })

  it('reads a notes reference within the limit and refuses an empty, an oversized or an extended one', () => {
    expect(ManifestSchema.parse(manifest({ notes: notes(1) })).notes?.length).toBe(1)
    expect(ManifestSchema.parse(manifest({ notes: notes(RELEASE_FILE_SIZE_LIMITS.notes) })).notes?.length).toBe(RELEASE_FILE_SIZE_LIMITS.notes)
    for (const bad of [notes(0), notes(RELEASE_FILE_SIZE_LIMITS.notes + 1), { ...notes(5), url: 'https://example.com' }, { ...notes(5), name: '../notes.txt' }]) {
      expect(ManifestSchema.safeParse(manifest({ notes: bad })).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('c02-notes-invalid-text-refused: notes are plain text of 1 to 65,536 bytes with only line feeds and tabs as controls', () => {
    const bytes = (text: string) => Buffer.from(text)
    expect(isValidNotes(bytes('Ünïcode, 日本語 and emoji 🚀\n\t- a bullet\n'))).toBe(true)
    expect(isValidNotes(Buffer.alloc(RELEASE_FILE_SIZE_LIMITS.notes, 'a'))).toBe(true)
    expect(isValidNotes(Buffer.alloc(RELEASE_FILE_SIZE_LIMITS.notes + 1, 'a'))).toBe(false)
    expect(isValidNotes(Buffer.alloc(0))).toBe(false)
    expect(isValidNotes(Buffer.from([0xff, 0xfe, 0x41]))).toBe(false)
    expect(isValidNotes(Buffer.from([0xed, 0xa0, 0x80]))).toBe(false)
    for (const text of ['override \u202Etext', 'escape \u001b[31m', 'carriage\rreturn', 'nul\u0000', 'bom\uFEFF', 'zero\u200Bwidth', 'line\u2028sep', 'para\u2029sep']) {
      expect(isValidNotes(bytes(text)), JSON.stringify(text)).toBe(false)
    }
  })
})
