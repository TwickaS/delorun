/** The store of plugin audit acceptances, which accepts nothing it cannot read. */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { acceptAudit, acceptedAudits, auditAcceptancesPath } from '../src/audit.ts'

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-audit-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

function record(dir: string, text: string): void {
  mkdirSync(join(dir, '.plugin-manager'), { recursive: true })
  writeFileSync(auditAcceptancesPath(dir), text)
}

it('accepts nothing before a first acceptance, then keeps the newest eight digests per package at mode 0600', async () => {
  const dir = profile()
  expect(await acceptedAudits(dir, 'audited')).toEqual([])
  for (let index = 1; index <= 9; index += 1) await acceptAudit(dir, 'audited', `digest-${String(index)}`)
  await acceptAudit(dir, 'audited', 'digest-4')
  await acceptAudit(dir, 'other', 'digest-x')
  expect(await acceptedAudits(dir, 'audited')).toEqual(['digest-2', 'digest-3', 'digest-5', 'digest-6', 'digest-7', 'digest-8', 'digest-9', 'digest-4'])
  expect(await acceptedAudits(dir, 'other')).toEqual(['digest-x'])
  expect(lstatSync(auditAcceptancesPath(dir)).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(auditAcceptancesPath(dir), 'utf8'))).toHaveProperty('other', ['digest-x'])
})

it.each([
  ['not JSON', '{'],
  ['a list', '["digest-1"]'],
  ['null', 'null'],
])('accepts nothing from a record that is %s, and the next acceptance replaces it', async (_kind, text) => {
  const dir = profile()
  record(dir, text)
  expect(await acceptedAudits(dir, 'audited')).toEqual([])
  await acceptAudit(dir, 'audited', 'digest-1')
  expect(await acceptedAudits(dir, 'audited')).toEqual(['digest-1'])
})

it('keeps only the string digests of a package and drops a package whose entry is not a list', async () => {
  const dir = profile()
  record(dir, JSON.stringify({ audited: ['digest-1', 2, null], other: 'digest-2' }))
  expect(await acceptedAudits(dir, 'audited')).toEqual(['digest-1'])
  expect(await acceptedAudits(dir, 'other')).toEqual([])
})

it('fails loud when the record cannot be read for another reason than its absence', async () => {
  const dir = profile()
  mkdirSync(auditAcceptancesPath(dir), { recursive: true })
  await expect(acceptedAudits(dir, 'audited')).rejects.toMatchObject({ code: 'EISDIR' })
})
