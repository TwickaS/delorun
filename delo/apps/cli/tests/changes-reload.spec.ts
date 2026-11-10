/**
 * The running Host's answer to C19's `changes.reload`: upstream's hot reload recomposes the profile, and anything but a
 * clean recomposition is reported as the reason the Host does not run what the files name.
 */
import { describe, expect, it } from 'vitest'
import { reloadProfile, type HotReload } from '../src/changes/reload.ts'

/**
 * @param reconcile - what the recomposition does.
 * @returns a hot reload whose exclusive runs record that they ran.
 */
function hotReload(reconcile: () => Promise<{ readonly restartReason?: string }>): HotReload & { exclusive: number } {
  const hmr = {
    exclusive: 0,
    async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
      hmr.exclusive += 1
      return operation()
    },
    reconcileProfile: reconcile,
  }
  return hmr
}

describe('reloading the running Host', () => {
  it('recomposes the profile inside one exclusive run and answers ok', async () => {
    const hmr = hotReload(async () => Promise.resolve({}))
    expect(await reloadProfile(hmr)).toEqual({ ok: true })
    expect(hmr.exclusive).toBe(1)
  })

  it('says to restart when hot reload is off or the change waits for a restart', async () => {
    expect(await reloadProfile(undefined)).toEqual({ ok: false, error: 'hot reload is off; restart Delo' })
    expect(await reloadProfile(hotReload(async () => Promise.resolve({ restartReason: 'package-moved' })))).toEqual({ ok: false, error: 'the change loads only after a restart (package-moved); restart Delo' })
  })

  it('reports a plugin that failed to load or start', async () => {
    expect(await reloadProfile(hotReload(async () => Promise.reject(new Error('plug failed to start'))))).toEqual({ ok: false, error: 'plug failed to start' })
    expect(await reloadProfile(hotReload(async () => Promise.reject('not an error')))).toEqual({ ok: false, error: 'not an error' })
  })
})
