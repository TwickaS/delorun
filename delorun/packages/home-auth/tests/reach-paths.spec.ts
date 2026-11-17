/**
 * The paths a signed-in device reaches (`src/reach-paths.ts`): the table's entries, exact and segment-bounded matching,
 * and the refusal of every target whose text names a path other than the one it reads as.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { describe, expect, it } from 'vitest'
import { plainPathname, REACH_DEVICE_PATHS, reachesDevicePath } from '../src/reach-paths.ts'

describe('the paths a signed-in device reaches', () => {
  it('lists each path once, as a plain absolute path with a reason', () => {
    const paths = REACH_DEVICE_PATHS.map(entry => entry.path)
    expect(new Set(paths).size).toBe(paths.length)
    for (const entry of REACH_DEVICE_PATHS) {
      expect(plainPathname(entry.path)).toBe(entry.path)
      expect(entry.path === '/' || !entry.path.endsWith('/')).toBe(true)
      expect(entry.reason).not.toBe('')
    }
  })

  it('matches an exact entry only as itself and a prefix entry only on a segment boundary', () => {
    // Pins the match kinds: an exact entry matched as a prefix would admit every path under it.
    expect(reachesDevicePath('/')).toBe(true)
    expect(reachesDevicePath('/index.html')).toBe(false)
    expect(reachesDevicePath('/delorun/reach/status')).toBe(true)
    expect(reachesDevicePath('/delorun/reach/status/more')).toBe(false)
    expect(reachesDevicePath('/delorun/changes/state')).toBe(true)
    expect(reachesDevicePath('/delorun/changes/setup-export')).toBe(true)
    expect(reachesDevicePath('/delorun/changesx/state')).toBe(false)
    expect(reachesDevicePath('/delorun/branding/icon')).toBe(true)
    expect(reachesDevicePath('/delorun/branding/icon/x')).toBe(false)
    expect(reachesDevicePath('/delorun/branding')).toBe(false)
    expect(reachesDevicePath('/favicon.svg.map')).toBe(false)
    // Pins the ICO as an install file: browsers ask for it on their own, and a refused request leaves a stale icon cached.
    expect(reachesDevicePath('/favicon.ico')).toBe(true)
    expect(reachesDevicePath('/favicon.ico/x')).toBe(false)
    // Pins the segment boundary: `/api` does not admit `/apix`.
    expect(reachesDevicePath('/api')).toBe(true)
    expect(reachesDevicePath('/api/session.list')).toBe(true)
    expect(reachesDevicePath('/api/remote.mux')).toBe(true)
    expect(reachesDevicePath('/apix')).toBe(false)
    expect(reachesDevicePath('/plugins/events')).toBe(true)
    expect(reachesDevicePath('/assets/index-abc.js')).toBe(true)
    expect(reachesDevicePath('/auth/session')).toBe(true)
    expect(reachesDevicePath('/open-in-app/apps')).toBe(false)
    expect(reachesDevicePath('/open-in-app/open')).toBe(false)
  })

  it('reads the pathname alone, so a query or fragment names nothing', () => {
    expect(reachesDevicePath('/api/session.list?x=1')).toBe(true)
    // Pins the split at the query: the query is not part of the path the table matches.
    expect(reachesDevicePath('/open-in-app/apps?/api')).toBe(false)
    expect(reachesDevicePath('/open-in-app/apps?next=/assets/x')).toBe(false)
    expect(reachesDevicePath('/open-in-app/apps#/api')).toBe(false)
    expect(plainPathname('/api?a=b')).toBe('/api')
  })

  it('refuses a target that the URL parser or a route would read as another path', () => {
    // Pins the parse comparison: each normalises onto `/open-in-app/apps` while its text begins with a listed prefix.
    for (const target of [
      '/assets/../open-in-app/apps',
      '/assets/%2e%2e/open-in-app/apps',
      '/assets/%2E%2E/open-in-app/apps',
      '/api/./../open-in-app/apps',
      '/assets\\..\\open-in-app\\apps',
      '/api/\t../open-in-app/apps',
      '/assets/./index.js',
    ]) {
      expect({ target, reaches: reachesDevicePath(target) }).toEqual({ target, reaches: false })
    }
    // Pins the empty-segment and escaped-separator checks, which the parser leaves as written.
    for (const target of ['//open-in-app/apps', '/api//session.list', '/assets/..%2Fopen-in-app%2Fapps', '/assets/..%2fx', '/assets/..%5Cx', '/assets/..%5cx']) {
      expect({ target, reaches: reachesDevicePath(target) }).toEqual({ target, reaches: false })
    }
    // Pins the origin-form requirement: an absolute or empty target names no path here.
    for (const target of ['', '*', 'http://home.example.ts.net/api', 'api']) {
      expect({ target, reaches: reachesDevicePath(target) }).toEqual({ target, reaches: false })
    }
    // Other escapes stay as written and match as their text.
    expect(reachesDevicePath('/assets/a%20b.js')).toBe(true)
  })
})
