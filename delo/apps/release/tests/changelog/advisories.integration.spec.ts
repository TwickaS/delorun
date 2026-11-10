import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { acceptedAdvisories, run } from '../../src/changelog/assemble.ts'
import { capture, fragmentText, LEDGER, scratchRepo, UNRELEASED } from './support.ts'

const signedManifest = vi.hoisted(() => ({ value: undefined as unknown }))

vi.mock('@delo/release-formats/sign/schemas', () => ({ readEnvelope: () => ({ signed: { advisories: signedManifest.value } }) }))

const ACCEPTED = { advisory: 'GHSA-1111-2222-3333', package: 'example-parser', range: '<1.2.5', reason: 'The parser is not reachable.', approver: 'example-maintainer', lapsesAfter: '0.3.0', added: '2026-11-06' }

/**
 * An advisory report for a version, as its bytes and the signed manifest's reference to it.
 * @param findings - the report's findings; omitted from the report when undefined.
 * @param ids - the accepted ids the manifest lists.
 * @returns the bytes and the reference.
 */
function report(findings: readonly object[] | undefined, ids: readonly string[]): { bytes: Buffer, signed: { report: { name: string, length: number, sha256: string }, accepted: readonly string[] } } {
  const bytes = Buffer.from(JSON.stringify({ schema: 'delo.release-advisories/1', version: '0.1.0-preview.1', result: 'pass', findings }))
  return { bytes, signed: { report: { name: 'report.json', length: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }, accepted: ids } }
}

describe('the accepted advisories of a version', () => {
  it('keeps each accepted advisory once and ignores findings that were not accepted', () => {
    const { bytes, signed } = report([{ accepted: ACCEPTED }, {}, { accepted: ACCEPTED }], [ACCEPTED.advisory])
    expect(acceptedAdvisories(bytes, '0.1.0-preview.1', signed as never)).toEqual([ACCEPTED])
  })

  it('accepts a report without findings when the manifest lists none', () => {
    const { bytes, signed } = report(undefined, [])
    expect(acceptedAdvisories(bytes, '0.1.0-preview.1', signed as never)).toEqual([])
  })
})

describe('the --advisories option', () => {
  it('lists the accepted advisories at the end of the notes', (test) => {
    const repo = scratchRepo(test)
    repo.commit({ 'delo/upstream-patches.json': LEDGER, [`${UNRELEASED}one.md`]: fragmentText('Setup', 'Added', ['One.']) })
    const directory = mkdtempSync(join(tmpdir(), 'delo-advisories-'))
    test.onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
    const { bytes, signed } = report([{ accepted: ACCEPTED }], [ACCEPTED.advisory])
    signedManifest.value = signed
    writeFileSync(join(directory, 'report.json'), bytes)
    writeFileSync(join(directory, 'manifest.json'), '{}')
    const output = capture()
    const args = ['--version', '0.1.0-preview.1', '--dry-run', '--advisories', join(directory, 'report.json'), '--manifest', join(directory, 'manifest.json')]
    expect(run(args, repo.root, output.sink)).toBe(0)
    expect(output.out.join('\n')).toContain('## Accepted advisories\n\nThis release ships with these dependency advisories under a reviewed acceptance:\n\n- GHSA-1111-2222-3333 in `example-parser` `<1.2.5`: The parser is not reachable. Approved by example-maintainer on 2026-11-06; the acceptance lapses after 0.3.0.')
    signedManifest.value = { ...signed, accepted: [] }
    const refused = capture()
    expect(run(args, repo.root, refused.sink)).toBe(1)
    expect(refused.all()).toContain('accepts other advisories than the signed manifest lists')
  })
})
