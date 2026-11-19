/**
 * Mounting the account service (`src/accounts/wiring.ts`): a driver registration for an agent with no stored figures
 * runs one check through the gate's `probe`; the routes are registered; disposing the context removes the hook and
 * aborts a check in progress.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountObservation, ExternalAgentName } from '../src/contract.ts'
import { wireAccounts } from '../src/accounts/wiring.ts'
import { ACCOUNT_ROUTES } from '../src/accounts/wire.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('wiring the account service', () => {
  it('checks a newly added agent through probe, registers the routes, and ends both on disposal', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ea1-limits-wiring-'))
    roots.push(home)
    const disposers: (() => void)[] = []
    const routes: string[] = []
    const ctx = {
      effect: (start: () => () => void) => { disposers.push(start()) },
      on: () => {},
      get: () => undefined,
      connection: { fetch: { register: (route: { path: string }) => { routes.push(route.path) } } },
    }
    let listener: ((provider: ExternalAgentName) => void) | undefined
    let removed = false
    const signals: AbortSignal[] = []
    const gate = {
      probe: vi.fn((provider: ExternalAgentName, signal: AbortSignal): Promise<AccountObservation> => {
        signals.push(signal)
        return Promise.resolve({ provider, signedIn: 'yes', windows: [], source: 'probe' })
      }),
      onDriverRegistered: (registered: (provider: ExternalAgentName) => void) => { listener = registered; return () => { removed = true } },
    }
    const accounts = wireAccounts(ctx as never, gate, {
      home, config: () => ({ probeMinIntervalMinutes: 30, probeTriggers: ['pack-added', 'signed-in', 'check-now'] }), installed: () => true, report: () => {},
    })
    expect(routes.sort()).toEqual(Object.values(ACCOUNT_ROUTES).sort())
    listener?.('codex')
    await vi.waitFor(async () => { expect((await accounts.read('codex')).signedIn).toBe('yes') })
    expect(gate.probe).toHaveBeenCalledExactlyOnceWith('codex', expect.any(AbortSignal))
    for (const dispose of disposers) dispose()
    expect(removed).toBe(true)
    expect(signals[0]?.aborted).toBe(true)
  })
})
