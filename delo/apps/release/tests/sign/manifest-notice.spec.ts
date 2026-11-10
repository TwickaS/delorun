/**
 * The release manifest's notice fields, `security` and `summary`: a reader accepts a manifest without them, as a reader
 * sees no security marker and no summary there, and refuses a summary a terminal or the studio could not print as one
 * plain line, a summary above the length limit and a `security` that is not a boolean.
 */
import { describe, expect, it } from 'vitest'
import { isValidSummary, RELEASE_SUMMARY_MAX_LENGTH, type ReleaseManifest } from '@delo/contract-release-manifest'
import { ManifestSchema } from '@delo/release-formats/sign/schemas'
import { manifestContent } from './fixture.ts'

/** A manifest the fixture builds, with its notice fields replaced or removed. */
function manifest(fields: Record<string, unknown>, remove: readonly string[] = []): Record<string, unknown> {
  const content: Record<string, unknown> = { ...manifestContent('0.1.0', Buffer.from('archive')), ...fields }
  for (const field of remove) delete content[field]
  return content
}

describe('the manifest\'s notice fields', () => {
  it('c02-summary-control-characters-refused: a reader refuses a summary holding an escape, a newline or a right-to-left override', () => {
    for (const summary of ['Fixes \u001b[31mred\u001b[0m text', 'Two\nlines', 'Fixes ‮evil.exe']) {
      expect(ManifestSchema.safeParse(manifest({ summary })).success, JSON.stringify(summary)).toBe(false)
      expect(isValidSummary(summary)).toBe(false)
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
