/**
 * The parts of `delorun start` that read a booted profile (`delo/apps/cli/src/start.ts`): the Loader's rows with their
 * states and configs, by the fiber numbers Cordis's own source declares; the services of the root context; and the
 * Host the home process runs, with its studio address and its health check.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { bootedRows, FIBER_STATES, runningHost, serviceProvider, type BootedProfile } from '../src/start.ts'


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
    root.provide('loader', { entries: () => [{ options: { id: 'delo-fetch-guard' }, fiber: rowFiber }] })
    expect(serviceProvider(root, 'fetchGuard')).toEqual({ row: 'delo-fetch-guard' })
    expect(serviceProvider(root, 'sandbox')).toEqual({ row: undefined })
    expect(serviceProvider(root, 'absent')).toBeUndefined()
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
        rows: () => [{ id: 'mcp', name: '@x/mcp', disabled: false, state: 'failed' }, { id: 'ok', name: '@x/ok', disabled: false, state: 'active' }],
        providerOf: () => undefined,
        releaseTurns: () => { calls.push('release') },
        shutdown: (code) => { calls.push(`shutdown ${String(code)}`); return Promise.resolve() },
        dispose: () => { calls.push('dispose'); return Promise.resolve() },
        watchChats: () => { calls.push('watch') },
        watchUpdates: () => Promise.resolve(),
        studio: () => studio,
        studioLink: () => ({ kind: 'unavailable', reason: 'the Host serves no studio' }),
      },
    }
  }

  it('names the studio by its address, an IPv6 one in brackets, and none without a listener', () => {
    expect(runningHost(profile({ host: '127.0.0.1', port: 3080 }).booted, { home: '/h', profile: 'default' }, [], () => Promise.resolve()).studio()).toBe('http://127.0.0.1:3080/')
    expect(runningHost(profile({ host: '::1', port: 3080 }).booted, { home: '/h', profile: 'default' }, [], () => Promise.resolve()).studio()).toBe('http://[::1]:3080/')
    expect(runningHost(profile(undefined).booted, { home: '/h', profile: 'default' }, [], () => Promise.resolve()).studio()).toBeUndefined()
  })

  it('counts chats, keeps the rows it had at boot and the ones that failed, and closes through the shutdown and suspends through the teardown', async () => {
    const { booted, calls } = profile(undefined)
    const host = runningHost(booted, { home: '/nonexistent-home', profile: 'default' }, [], () => Promise.resolve())
    expect(calls).toEqual(['watch'])
    expect(host.rows()).toEqual([{ id: 'mcp', name: '@x/mcp', generated: false }, { id: 'ok', name: '@x/ok', generated: false }])
    expect(host.failedRows()).toEqual([{ id: 'mcp', name: '@x/mcp', generated: false }])
    await host.suspend()
    await host.close()
    expect(calls).toEqual(['watch', 'dispose', 'shutdown 0'])
  })
})
