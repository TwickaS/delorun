import { describe, expect, it } from 'vitest'
import { assertRowsExist } from '../src/rows.ts'

describe('the optional rows check', () => {
  // A row inside an `include` subtree reports a prefixed `id` ("include:delo-cost-meter") and its own id in `options.id`.
  const rows = (...ids: string[]) => ({ entries: () => ids.map(id => ({ id: `include:${id}`, options: { id } })) })

  it('accepts rows the profile holds and a profile that lists none', () => {
    expect(() => assertRowsExist(['delo-cost-meter', 'delo-thinking-rsvp'], rows('delo-theme', 'delo-cost-meter', 'delo-thinking-rsvp'))).not.toThrow()
    expect(() => assertRowsExist([], undefined)).not.toThrow()
  })

  it('stops the plugin at load, naming a row the profile has no row for', () => {
    expect(() => assertRowsExist(['delo-cost-meter', 'delo-cost-metre'], rows('delo-cost-meter'))).toThrow('"delo-cost-metre"')
  })

  it('stops the plugin at load when rows are listed and there is no Loader to check them', () => {
    expect(() => assertRowsExist(['delo-cost-meter'], undefined)).toThrow('no Loader')
  })
})
