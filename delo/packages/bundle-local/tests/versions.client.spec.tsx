// @vitest-environment jsdom
/** The version row names Delo's version and the DeepSeek Harness version, from the page global the harness prints. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { DeloVersionRow, type DeloVersionRowProps } from '../src/client/DeloVersionRow.tsx'
import { en } from '../src/client/locales.ts'
import { readVersions, VERSIONS_GLOBAL } from '../src/client/versions.ts'

afterEach(() => { cleanup() })

const t = (key: keyof typeof en, params: { version: string }): string => en[key].replace('{version}', params.version)

describe('the page global', () => {
  it('reads two version strings', () => {
    expect(readVersions({ [VERSIONS_GLOBAL]: { delo: '0.1.0', dsh: '0.2.2-rc.1' } })).toEqual({ delo: '0.1.0', dsh: '0.2.2-rc.1' })
  })

  it('reads nothing from a page without it, or with anything other than two version strings', () => {
    expect(readVersions({})).toBeUndefined()
    expect(readVersions({ [VERSIONS_GLOBAL]: null })).toBeUndefined()
    expect(readVersions({ [VERSIONS_GLOBAL]: 'v1' })).toBeUndefined()
    expect(readVersions({ [VERSIONS_GLOBAL]: { delo: '0.1.0' } })).toBeUndefined()
    expect(readVersions({ [VERSIONS_GLOBAL]: { delo: 1, dsh: '0.2.2' } })).toBeUndefined()
    expect(readVersions({ [VERSIONS_GLOBAL]: { delo: '<img src=x>', dsh: '0.2.2' } })).toBeUndefined()
    expect(readVersions({ [VERSIONS_GLOBAL]: { delo: '0.1.0', dsh: '0.2.2 and more' } })).toBeUndefined()
  })

  it('reads globalThis by default', () => {
    Reflect.set(globalThis, VERSIONS_GLOBAL, { delo: '0.1.0', dsh: '0.2.2' })
    try {
      expect(readVersions()).toEqual({ delo: '0.1.0', dsh: '0.2.2' })
    } finally {
      Reflect.deleteProperty(globalThis, VERSIONS_GLOBAL)
    }
  })
})

describe('the version row', () => {
  it('labels Delo\'s version first and the DeepSeek Harness version beneath it', () => {
    const props = { versions: { delo: '0.1.0', dsh: '0.2.2-rc.1' }, t } as DeloVersionRowProps
    render(<DeloVersionRow {...props} />)
    expect(screen.getByText('Delo version: 0.1.0')).toBeTruthy()
    expect(screen.getByText('DeepSeek Harness version: 0.2.2-rc.1')).toBeTruthy()
  })
})
