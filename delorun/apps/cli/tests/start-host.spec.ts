/**
 * The parts of `delorun start` that read a booted profile (`delorun/apps/cli/src/start.ts`): the Loader's rows with their
 * states and configs, by the fiber numbers Cordis's own source declares; the services of the root context; and the
 * Host the home process runs, with its studio address and its health check.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { ReachOptionStatus } from '@delorun/contract-home-process'
import type { ReachConfigRows } from '@delorun/contract-reach-providers'
import { FAIL_CLOSED_STUB } from '@delorun/home'
import type { RunningHost } from '@delorun/home-process'
import type { BootedRow } from '../src/delorun-bundles.ts'
import { bootedRows, FIBER_STATES, runningHost, serviceProvider, type BootedProfile } from '../src/start.ts'
import { bootRowsOf } from '../src/update/host.ts'


/**
 * A root context whose Loader holds the given entries.
 * @param entries - the entries, or `undefined` for a context without a Loader.
 * @param services - the services it provides.
 * @returns the context.
 */
function contextWith(entries: readonly object[] | undefined, services: Readonly<Record<string, unknown>> = {}): Context {
  const loader = entries === undefined ? undefined : { entries: () => entries }
  const get = (name: string): unknown => (name === 'loader' ? loader : services[name])
  return { get } as Context
}

describe('the fiber states the audit mirrors', () => {
  it('are the numbers Cordis\'s FiberState declares', () => {
    const source = readFileSync(join(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json')), 'src', 'fiber.ts'), 'utf8')
    const body = /export const enum FiberState \{([^}]*)\}/u.exec(source)?.[1]
    const names = (body ?? '').split(',').map(name => name.trim()).filter(name => name !== '')
    for (const [name, value] of Object.entries(FIBER_STATES)) expect(names.indexOf(name), name).toBe(value)
  })
})

describe('bootedRows', () => {
  it('reads each row\'s state, disabled flag and config, and none without a Loader', () => {
    const entry = (id: string, state: number | undefined, extra: object = {}): object => ({ options: { id, name: `@x/${id}`, ...extra }, disabled: false, fiber: state === undefined ? undefined : { state } })
    const throwing = { options: { id: 'expr', name: '@x/expr' }, get disabled(): boolean { throw new Error('the expression threw') } }
    expect(bootedRows(contextWith(undefined))).toEqual([])
    expect(bootedRows(contextWith([
      entry('a', FIBER_STATES.ACTIVE, { config: { enabled: true } }),
      entry('p', FIBER_STATES.PENDING),
      entry('d', FIBER_STATES.DISPOSED),
      entry('n', undefined),
      entry('f', 3),
      throwing,
    ]))).toEqual([
      { id: 'a', name: '@x/a', disabled: false, state: 'active', config: { enabled: true } },
      { id: 'p', name: '@x/p', disabled: false, state: 'pending' },
      { id: 'd', name: '@x/d', disabled: false, state: 'not-imported' },
      { id: 'n', name: '@x/n', disabled: false, state: 'not-imported' },
      { id: 'f', name: '@x/f', disabled: false, state: 'failed' },
      { id: 'expr', name: '@x/expr', disabled: false, state: 'failed' },
    ])
  })

  it('names the row whose fiber, or an ancestor of it, provides a service, and no row for a provider outside the Loader\'s rows', async () => {
    const root = new Context()
    let rowFiber: Fiber | undefined
    await root.plugin({ name: 'guard-row', apply: (ctx: Context) => {
      rowFiber = ctx.fiber
      void ctx.plugin({ name: 'guard-child', apply: (child: Context) => { child.provide('fetchGuard', {}) } })
    } })
    await root.plugin({ name: 'other', apply: (ctx: Context) => { ctx.provide('sandbox', {}) } })
    root.provide('loader', { entries: () => [{ options: { id: 'delorun-fetch-guard' }, fiber: rowFiber }] })
    expect(serviceProvider(root, 'fetchGuard')).toEqual({ row: 'delorun-fetch-guard' })
    expect(serviceProvider(root, 'sandbox')).toEqual({ row: undefined })
    expect(serviceProvider(root, 'absent')).toBeUndefined()
    root.provide('scheduleConsent', { [FAIL_CLOSED_STUB]: true })
    expect(serviceProvider(root, 'scheduleConsent')).toEqual({ row: undefined, failClosed: true })
    await root.fiber.dispose()
  })
})

describe('runningHost', () => {
  /**
   * A booted profile with a studio address.
   * @param studio - the address, or `undefined`.
   * @returns the profile and what it recorded.
   */
  function profile(studio: { host: string, port: number } | undefined): { readonly booted: BootedProfile, readonly calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      booted: {
        configSchemas: () => [],
        settleSecretValues: () => Promise.resolve({ moved: [], notices: [] }),
        rows: () => [{ id: 'mcp', name: '@x/mcp', disabled: false, state: 'failed' }, { id: 'ok', name: '@x/ok', disabled: false, state: 'active' }],
        providerOf: () => undefined,
        releaseTurns: () => { calls.push('release') },
        shutdown: (code) => { calls.push(`shutdown ${String(code)}`); return Promise.resolve() },
        dispose: () => { calls.push('dispose'); return Promise.resolve() },
        watchChats: () => { calls.push('watch') },
        watchUpdates: () => Promise.resolve(),
        studio: () => studio,
        studioLink: () => ({ kind: 'unavailable', reason: 'the Host serves no studio' }),
        reload: () => { calls.push('reload'); return Promise.resolve({ ok: true }) },
      },
    }
  }

  it('names the studio by its address, an IPv6 one in brackets, and none without a listener', () => {
    expect(runningHost(profile({ host: '127.0.0.1', port: 3080 }).booted, { home: '/h', profile: 'default' }, [], () => Promise.resolve(), () => Promise.resolve()).studio()).toBe('http://127.0.0.1:3080/')
    expect(runningHost(profile({ host: '::1', port: 3080 }).booted, { home: '/h', profile: 'default' }, [], () => Promise.resolve(), () => Promise.resolve()).studio()).toBe('http://[::1]:3080/')
    expect(runningHost(profile(undefined).booted, { home: '/h', profile: 'default' }, [], () => Promise.resolve(), () => Promise.resolve()).studio()).toBeUndefined()
  })

  it('counts chats, keeps the rows it had at boot and the ones that failed, reloads through the profile, and ends Changes\' part before it closes through the shutdown and suspends through the teardown', async () => {
    const { booted, calls } = profile(undefined)
    const host = runningHost(booted, { home: '/nonexistent-home', profile: 'default' }, [], () => Promise.resolve(), () => { calls.push('end changes'); return Promise.resolve() })
    expect(calls).toEqual(['watch'])
    expect(host.rows()).toEqual([{ id: 'mcp', name: '@x/mcp', generated: false }, { id: 'ok', name: '@x/ok', generated: false }])
    expect(host.failedRows()).toEqual([{ id: 'mcp', name: '@x/mcp', generated: false }])
    expect(await host.reload()).toEqual({ ok: true })
    await host.suspend()
    await host.close()
    expect(calls).toEqual(['watch', 'reload', 'end changes', 'dispose', 'end changes', 'shutdown 0'])
  })

  describe('after a reach.apply', () => {
    const manager: BootedRow = { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager', disabled: false, state: 'active', config: { protectedPlugins: ['@delorun/reach'] } }
    const reachRow = (config: unknown): BootedRow => ({ id: 'delorun-reach', name: '@delorun/reach', disabled: false, state: 'active', config })
    // @delorun/bundle-local's row, which the Host booted with before `delorun reach on` wrote the profile's own.
    const boot = { enabled: true, tailscalePrivate: { enabled: false, address: '', servePort: 443 } }
    const on = { enabled: true, tailscalePrivate: { enabled: true, address: 'https://home.example.ts.net', servePort: 443, listenerPort: 31318, serveCheckIntervalMs: 60000, elevationMinutes: 15 } }
    // The profile's patch holds the reach row in every case, so the Host marks it `personEdited` at boot and after an apply (H3 derives no change for it).
    const inPatch = (rows: readonly BootedRow[]): ReturnType<typeof bootRowsOf> => bootRowsOf(rows, new Set(['delorun-reach']))
    const homes: string[] = []
    afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

    /**
     * A Host booted with the bundle's reach row whose reach service answers each apply with `answer`, in a home whose
     * profile patch holds `patch`.
     * @param patch - the profile's `cordis.patch.yml` rows, or undefined for no file.
     * @param answer - what the service's apply answers.
     * @returns the Host and the rows each apply restarted from.
     */
    function reachHost(patch: readonly object[] | undefined, answer: readonly ReachOptionStatus[] | undefined): { readonly host: RunningHost, readonly restarted: ReachConfigRows[] } {
      const home = mkdtempSync(join(tmpdir(), 'dsr-'))
      homes.push(home)
      mkdirSync(join(home, 'profiles', 'default'), { recursive: true })
      if (patch !== undefined) writeFileSync(join(home, 'profiles', 'default', 'cordis.patch.yml'), stringify(patch))
      const restarted: ReachConfigRows[] = []
      const booted: BootedProfile = {
        ...profile(undefined).booted,
        rows: () => [manager, reachRow(boot)],
        reach: rows => ({ status: () => [], apply: () => { restarted.push(rows()); return Promise.resolve(answer) } }),
      }
      return { host: runningHost(booted, { home, profile: 'default' }, [], () => Promise.resolve(), () => Promise.resolve()), restarted }
    }

    it('hands over the hash a boot from the file `delorun reach on` wrote gives, once the service applied its option', async () => {
      const { host, restarted } = reachHost([{ id: 'delorun-reach', config: on }], [{ option: 'tailscale-private', state: 'ready' }])
      expect(host.rows()).toEqual(inPatch([manager, reachRow(boot)]))
      await host.reach?.apply()
      expect(restarted.map(rows => rows.tailscalePrivate?.address)).toEqual(['https://home.example.ts.net'])
      expect(host.rows()).toEqual(inPatch([manager, reachRow(on)]))
    })

    it('keeps the boot config of every key but the applied option, so the file\'s other changes still show', async () => {
      const { host } = reachHost([{ id: 'delorun-reach', config: { ...on, enabled: false, other: 1 } }], [{ option: 'tailscale-private', state: 'ready' }])
      await host.reach?.apply()
      expect(host.rows()).toEqual(inPatch([manager, reachRow({ ...boot, tailscalePrivate: on.tailscalePrivate })]))
      expect(host.rows()).not.toEqual(inPatch([manager, reachRow({ ...on, enabled: false, other: 1 })]))
    })

    it('keeps the boot hash when the service did not run the apply', async () => {
      const { host } = reachHost([{ id: 'delorun-reach', config: on }], undefined)
      await host.reach?.apply()
      expect(host.rows()).toEqual(inPatch([manager, reachRow(boot)]))
    })
  })
})
