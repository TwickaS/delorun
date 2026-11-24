import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALLOWLIST_PATH, fileErrors, isScanned, lineFindings, readAllowlist, type Allowlist } from '../../src/checks/gates/design-system.ts'
import { REPO } from './support.ts'

const NONE: Allowlist = { entries: [] }
// The package names and the import syntax are assembled at run time, so this file holds no import the gate would find.
const PRIMITIVES = ['@deepseek-ai', 'dsh-client-ui-primitives'].join('/')
const BRAND = ['@delorun', 'brand'].join('/')
const from = (names: string, specifier: string): string => `import { ${names} } from '${specifier}'`

/** A Delorun surface the contract migrates, and one that already renders the brand's `Dialog`. */
const CONSENT = 'delorun/packages/bundle-local/src/client/FullAccessConsent.tsx'
const MIGRATED = 'delorun/packages/bundle-local/src/client/ReportProblem.tsx'

describe('the design-system gate', () => {
  it('refuses a raw Modal deliberately put back into a file that already renders the brand Dialog', () => {
    const migrated = readFileSync(join(REPO, MIGRATED), 'utf8')
    expect(migrated).toContain(`from '${BRAND}'`)
    const putBack = `${from('Modal', PRIMITIVES)}\n${migrated}`
    expect(fileErrors(MIGRATED, migrated, NONE)).toEqual([])
    expect(fileErrors(MIGRATED, putBack, NONE)).toEqual([`${MIGRATED}:1: modal: import Dialog from @delorun/brand`])
  })

  it('refuses Button, Pill and SegmentedTabs from the primitives package', () => {
    expect(lineFindings(from('Button', PRIMITIVES)).map(finding => finding.rule)).toEqual(['button'])
    expect(lineFindings(from('Pill', PRIMITIVES)).map(finding => finding.rule)).toEqual(['pill'])
    expect(lineFindings(from('SegmentedTabs', PRIMITIVES)).map(finding => finding.rule)).toEqual(['tabs'])
    expect(lineFindings(from('Button', PRIMITIVES))[0]?.message).toBe('button: import Button from @delorun/brand')
    expect(lineFindings(from('Pill', PRIMITIVES))[0]?.message).toBe('pill: import Pill from @delorun/brand')
    expect(lineFindings(from('SegmentedTabs', PRIMITIVES))[0]?.message).toBe('tabs: import TabList and TabPanel from @delorun/brand')
  })

  it('refuses a raw anchor with an href in a Delorun client source and accepts the brand Link', () => {
    const raw = `export const A = () => <a className={css.link} href={url}>docs</a>`
    expect(lineFindings(raw, true).map(finding => finding.rule)).toEqual(['link'])
    expect(lineFindings(raw, true)[0]?.message).toBe('link: import Link from @delorun/brand')
    expect(lineFindings(`export const A = () => <Link className={css.link} href={url}>docs</Link>`, true)).toEqual([])
    expect(lineFindings(`export const A = () => <a name="top" />`, true)).toEqual([])
  })

  it('accepts the brand imports and the upstream primitives the contract does not touch', () => {
    const brand = from('Button, Dialog, Link, Pill, TabList, TabPanel', BRAND)
    const untouched = from('Checkbox, Input, Menu, MenuSurface, SegmentedControl, StateDot, Switch, Tag, TextShimmer, Toast, Tooltip', PRIMITIVES)
    expect(lineFindings(`${brand}\n${untouched}`, true)).toEqual([])
    expect(fileErrors(CONSENT, `${brand}\n${untouched}`, NONE)).toEqual([])
  })

  it('reads the Delorun package sources and the ledger-listed upstream files, and nothing else', () => {
    const ledger = new Set(['packages/client/ui-chat/src/client/chat/ChatView.tsx'])
    expect(isScanned(CONSENT, ledger)).toBe(true)
    expect(isScanned('packages/client/ui-chat/src/client/chat/ChatView.tsx', ledger)).toBe(true)
    expect(isScanned('packages/client/ui-schedule/src/client/SchedulePage.tsx', ledger)).toBe(false)
    expect(isScanned('delorun/packages/brand/src/icon-picker.tsx', ledger)).toBe(false)
    expect(isScanned('packages/client/ui-primitives/src/Modal.tsx', ledger)).toBe(false)
    expect(isScanned('delorun/packages/bundle-local/tests/consent.spec.tsx', ledger)).toBe(false)
    expect(isScanned('delorun/packages/bundle-local/scripts/build.ts', ledger)).toBe(false)
    expect(isScanned('delorun/packages/bundle-local/src/client/FullAccessConsent.module.css', ledger)).toBe(false)
    expect(fileErrors('delorun/packages/brand/src/icon-picker.tsx', from('Button, Modal', PRIMITIVES), NONE)).toEqual([])
    expect(fileErrors('packages/client/ui-primitives/src/Modal.tsx', from('Button, Modal', PRIMITIVES), NONE)).toEqual([])
  })

  it('exempts one rule of one file by the allowlist and refuses the same file\'s other rule', () => {
    const text = `${from('Button, Modal', PRIMITIVES)}\n${from('Dialog', BRAND)}`
    expect(fileErrors(CONSENT, text, NONE)).toEqual([
      `${CONSENT}:1: button: import Button from @delorun/brand`,
      `${CONSENT}:1: modal: import Dialog from @delorun/brand`,
    ])
    const exempt: Allowlist = { entries: [{ path: CONSENT, rule: 'modal', reason: 'test' }] }
    expect(fileErrors(CONSENT, text, exempt)).toEqual([`${CONSENT}:1: button: import Button from @delorun/brand`])
  })

  it('refuses a file that is not in the ledger, then accepts it once the ledger lists it', () => {
    const path = 'packages/client/ui-schedule/src/client/SchedulePage.tsx'
    const text = from('Button, Modal', PRIMITIVES)
    expect(fileErrors(path, text, NONE)).toEqual([])
    expect(fileErrors(path, text, NONE, new Set([path]))).toEqual([
      `${path}:1: button: import Button from @delorun/brand`,
      `${path}:1: modal: import Dialog from @delorun/brand`,
    ])
  })

  it('reports the line of each name in an import that spans lines', () => {
    const text = [
      'import {',
      '  Button, IconChevronDownOutlineRegular, Input,',
      '  Modal, SegmentedControl,',
      `} from '${PRIMITIVES}'`,
    ].join('\n')
    expect(lineFindings(text).map(finding => `${String(finding.line)} ${finding.rule}`)).toEqual(['2 button', '3 modal'])
  })

  it('holds the shipped allowlist to one non-empty reason per file and rule', () => {
    const allowlist = readAllowlist(join(REPO, ALLOWLIST_PATH))
    expect(allowlist.entries.length).toBeGreaterThan(0)
    for (const entry of allowlist.entries) {
      expect(entry.reason.trim(), entry.path).not.toBe('')
      expect(['button', 'modal', 'pill', 'tabs', 'link'], entry.path).toContain(entry.rule)
    }
    const keys = allowlist.entries.map(entry => `${entry.path}|${entry.rule}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
