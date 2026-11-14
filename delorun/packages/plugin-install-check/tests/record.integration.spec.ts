/**
 * Reading install records (`src/record.ts`): a record holding any rule the checker can record reads back, and a
 * record holding a rule the checker never records is refused.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FINDING_RULES } from '../src/findings.ts'
import { INSTALL_RECORD_SCHEMA, readInstallRecord, recordPath } from '../src/record.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Write a record file whose single finding carries the given rule.
 * @param rule - the finding's rule.
 * @returns the profile directory.
 */
function profileWithRule(rule: string): string {
  const dir = mkdtempSync(`${tmpdir()}/delorun-record-rules-`)
  dirs.push(dir)
  const record = {
    schema: INSTALL_RECORD_SCHEMA,
    name: 'good-plugin',
    source: { kind: 'registry', reference: '1.0.0' },
    installedAt: 1,
    capturedAt: 1,
    findings: [{ rule, title: 'a finding', package: 'good-plugin', path: 'pnpm-lock.yaml', line: 0, severity: 'critical' }],
    allowedAdvisories: [],
    lockfileEntries: [],
    packages: [],
  }
  mkdirSync(dirname(recordPath(dir, 'good-plugin')), { recursive: true })
  writeFileSync(recordPath(dir, 'good-plugin'), JSON.stringify(record))
  return dir
}

describe('reading an install record', () => {
  it.each(FINDING_RULES)('reads a record that holds an allowed %s finding', async rule => {
    const record = await readInstallRecord(profileWithRule(rule), 'good-plugin')
    expect(record?.findings.map(finding => finding.rule)).toEqual([rule])
  })

  it('includes the two mirror integrity rules', () => {
    expect(FINDING_RULES).toEqual(expect.arrayContaining(['integrity-unconfirmed', 'integrity-mismatch']))
  })

  it('still refuses a record whose finding names an unknown rule', async () => {
    expect(await readInstallRecord(profileWithRule('made-up-rule'), 'good-plugin')).toBeUndefined()
  })
})
