import { describe, expect, it } from 'vitest'
import { assertRowsExist } from '../src/rows.ts'

describe('the optional rows check', () => {
  // A row inside an `include` subtree reports a prefixed `id` ("include:delorun-cost-meter") and its own id in `options.id`.
  const rows = (...ids: string[]) => ({ entries: () => ids.map(id => ({ id: `include:${id}`, options: { id } })) })

  it('accepts rows the profile holds and a profile that lists none', () => {
    expect(() => assertRowsExist(['delorun-cost-meter', 'delorun-thinking-rsvp'], rows('delorun-theme', 'delorun-cost-meter', 'delorun-thinking-rsvp'))).not.toThrow()
    expect(() => assertRowsExist([], undefined)).not.toThrow()
  })

  it('stops the plugin at load, naming a row the profile has no row for', () => {
    expect(() => assertRowsExist(['delorun-cost-meter', 'delorun-cost-metre'], rows('delorun-cost-meter'))).toThrow('"delorun-cost-metre"')
  })

  it('stops the plugin at load when rows are listed and there is no Loader to check them', () => {
    expect(() => assertRowsExist(['delorun-cost-meter'], undefined)).toThrow('no Loader')
  })
})
