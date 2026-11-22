import { describe, expect, it } from 'vitest'
import { INDEX_INJECTIONS_PATH, parseHomeInjections } from '../src/home-injections.ts'

describe('parseHomeInjections', () => {
  it('reads every row kind the bundled client applies, in order', () => {
    const rows = [
      { kind: 'global', name: 'DSH_THEME', value: { preference: 'dark' } },
      { kind: 'style', text: ':root{--x:1}' },
      { kind: 'script-preload', src: '/plugins/a.js' },
      { kind: 'script-src', placement: 'head', src: '/plugins/a.js?x=1&y=2' },
      { kind: 'script', placement: 'body', text: 'window.__B = 1' },
      { kind: 'html', placement: 'body', html: '<div id="portal"></div>' },
    ]
    expect(parseHomeInjections(rows)).toEqual(rows)
    expect(parseHomeInjections([])).toEqual([])
  })

  it.each([
    ['not a list', { kind: 'script' }],
    ['an unknown kind', [{ kind: 'eval', text: 'x' }]],
    ['a script without a placement', [{ kind: 'script', text: 'x' }]],
    ['a source that is not text', [{ kind: 'script-src', placement: 'head', src: 7 }]],
    ['a page', '<html></html>'],
    ['nothing', undefined],
  ])('refuses %s', (_name, value) => {
    expect(parseHomeInjections(value)).toBeUndefined()
  })

  it('names the Host route that answers the rows', () => {
    expect(INDEX_INJECTIONS_PATH).toBe('/index-injections.json')
  })
})
