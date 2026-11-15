// @vitest-environment jsdom
/** The version row and the versions line name Delorun's version and the DeepSeek Harness version, from the page global the harness prints. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { DelorunVersionRow, type DelorunVersionRowProps } from '../src/client/DelorunVersionRow.tsx'
import { en } from '../src/client/locales.ts'
import { VersionsRow, type VersionsRowProps } from '../src/client/VersionsRow.tsx'
import { readVersions, SOURCE_BUILD, VERSIONS_GLOBAL } from '../src/client/versions.ts'

afterEach(() => { cleanup() })

const t = (key: keyof typeof en, params: { version: string }): string => en[key].replace('{version}', params.version)

describe('the page global', () => {
  it('reads two version strings', () => {
    expect(readVersions({ [VERSIONS_GLOBAL]: { delorun: '0.1.0', dsh: '0.2.2-rc.1' } })).toEqual({ delorun: '0.1.0', dsh: '0.2.2-rc.1' })
  })

  it('shows a source build for the unstamped 0.0.0 of a checkout, and a stamped release version as it is', () => {
    expect(readVersions({ [VERSIONS_GLOBAL]: { delorun: '0.0.0', dsh: '0.2.2-rc.3' } })).toEqual({ delorun: SOURCE_BUILD, dsh: '0.2.2-rc.3' })
    expect(readVersions({ [VERSIONS_GLOBAL]: { delorun: '0.1.0-rc.4', dsh: '0.2.2-rc.3' } })?.delorun).toBe('0.1.0-rc.4')
  })

  it('reads nothing from a page without it, or with anything other than two version strings', () => {
    expect(readVersions({})).toBeUndefined()
    expect(readVersions({ [VERSIONS_GLOBAL]: null })).toBeUndefined()
    expect(readVersions({ [VERSIONS_GLOBAL]: 'v1' })).toBeUndefined()
    expect(readVersions({ [VERSIONS_GLOBAL]: { delorun: '0.1.0' } })).toBeUndefined()
    expect(readVersions({ [VERSIONS_GLOBAL]: { delorun: 1, dsh: '0.2.2' } })).toBeUndefined()
    expect(readVersions({ [VERSIONS_GLOBAL]: { delorun: '<img src=x>', dsh: '0.2.2' } })).toBeUndefined()
    expect(readVersions({ [VERSIONS_GLOBAL]: { delorun: '0.1.0', dsh: '0.2.2 and more' } })).toBeUndefined()
  })

  it('reads globalThis by default', () => {
    Reflect.set(globalThis, VERSIONS_GLOBAL, { delorun: '0.1.0', dsh: '0.2.2' })
    try {
      expect(readVersions()).toEqual({ delorun: '0.1.0', dsh: '0.2.2' })
    } finally {
      Reflect.deleteProperty(globalThis, VERSIONS_GLOBAL)
    }
  })
})

describe('the version row', () => {
  it('labels Delorun\'s version first and the DeepSeek Harness version beneath it', () => {
    const props = { versions: { delorun: '0.1.0', dsh: '0.2.2-rc.1' }, t } as DelorunVersionRowProps
    render(<DelorunVersionRow {...props} />)
    expect(screen.getByText('Delorun version: 0.1.0')).toBeTruthy()
    expect(screen.getByText('DeepSeek Harness version: 0.2.2-rc.1')).toBeTruthy()
  })
})

describe('the versions line', () => {
  it('names both versions on one line, Delorun\'s first', () => {
    const props = { versions: { delorun: '0.1.0', dsh: '0.2.2-rc.1' }, t: makeTranslate(en) } as VersionsRowProps
    render(<VersionsRow {...props} />)
    expect(screen.getByText('Delorun 0.1.0 · DeepSeek Harness 0.2.2-rc.1')).toBeTruthy()
  })
})
