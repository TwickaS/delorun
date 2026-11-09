/**
 * The search tools' protected-read fence in a Delo CLI profile: the row this bundle writes turns it on, which is what
 * makes `glob` and `grep` refuse the Delo home in the composition Delo ships, and upstream's web profile — the control
 * — stays on the switch's stock default. What the configuration buys is proven where the tools are:
 * `@deepseek-ai/dsh-tool-fs-search`'s own suite mounts them with `protectedReads: true` against a provider that
 * protects a home and reads a refusal and a filtered result out of `glob` and `grep`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LOCAL_ROWS, UPSTREAM_TEMPLATE } from '../src/profile.ts'
import { createTestHome, DELO_PROFILE, type ComposedRows, type TestHome } from './profiles.ts'

let home: TestHome
beforeAll(() => { home = createTestHome() })
afterAll(() => { home.remove() })

/**
 * The composed `tool-fs-search` row of a profile.
 * @param rows - a composed entry list.
 * @returns the row.
 */
function searchRow(rows: ComposedRows) {
  const row = rows.find(entry => entry.id === 'tool-fs-search')
  if (row === undefined) throw new Error('the composition holds no tool-fs-search row')
  return row
}

describe('the search tools\' protected reads in a Delo CLI profile', () => {
  it('turns the fence on, and restates the over-cap sampling choice the row replaces', () => {
    // A patch replaces the targeted row's whole config, so a row that set only the fence would drop the bundles'
    // required sampling choice; both keys are here, and the fence is the value the audit of the read fence called for.
    expect(searchRow(home.rows(DELO_PROFILE)).config).toEqual({ sampleOverCapGlobResults: false, protectedReads: true })
    // Removing this row leaves `protectedReads` at the Config default (false) and makes the assertion fail: the
    // search tools would walk into the Delo home again and print what they find there.
  })

  it('leaves upstream\'s web profile, the control, on the switch\'s default, which is its parity value', () => {
    // The parity composition rests on the Config default too (C16), so the absent key is the whole story of a profile
    // without this bundle: no fence. That is why the row is Delo's to write and not the base bundle's.
    expect(searchRow(home.rows(UPSTREAM_TEMPLATE)).config).toEqual({ sampleOverCapGlobResults: false })
    expect(searchRow(home.rows(UPSTREAM_TEMPLATE)).config).not.toHaveProperty('protectedReads')
  })

  it('lists the row as a change over upstream whose parity form is upstream\'s own', () => {
    // The composition spec and the parity overlay both read LOCAL_ROWS: an unlisted row fails the first, and a row
    // whose parity form is `upstream` is the one the overlay leaves out.
    expect(LOCAL_ROWS.find(row => row.id === 'tool-fs-search')).toMatchObject({ kind: 'changed', parity: { kind: 'upstream' } })
  })
})
