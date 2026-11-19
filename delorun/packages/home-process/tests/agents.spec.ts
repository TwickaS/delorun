/**
 * The update channel's external-agent account operations (contract C19): `agents.accounts` reads the figures with
 * either token, `agents.refresh` starts a check only for the person's own `delorun`, and both carry nothing but what
 * their schema allows.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { describe, expect, it } from 'vitest'
import { newStartToken } from '@delorun/home'
import type { AgentsAccountsRequest, AgentsRefreshRequest } from '@delorun/contract-home-process'
import { agentsAccounts, agentsRefresh, type LocalAgentAccounts } from '../src/index.ts'
import { checkUpdateRequest } from '../src/schema.ts'

/** A fake of the Host's account service that records every call. */
class FakeAccounts implements LocalAgentAccounts {
  readonly calls: string[] = []
  private readonly mounted: boolean

  constructor(mounted: boolean) {
    this.mounted = mounted
  }

  async accounts(): Promise<Readonly<Record<string, unknown>> | undefined> {
    this.calls.push('accounts')
    return Promise.resolve(this.mounted ? { accounts: [], now: 1 } : undefined)
  }

  async refresh(provider: string, reason: string): Promise<Readonly<Record<string, unknown>> | undefined> {
    this.calls.push(`refresh ${provider} ${reason}`)
    return Promise.resolve(this.mounted ? { outcome: { kind: 'checked' }, now: 1 } : undefined)
  }
}

const ACCOUNTS: AgentsAccountsRequest = { v: 1, token: newStartToken(), op: 'agents.accounts' }
const REFRESH: AgentsRefreshRequest = { v: 1, token: newStartToken(), op: 'agents.refresh', args: { provider: 'codex', reason: 'signed-in' } }

describe('agents.accounts and agents.refresh', () => {
  it('refuse a refresh with the Host\'s channel token before the account service is asked', async () => {
    const accounts = new FakeAccounts(true)
    // Pins the caller rule: without it the Host's token, which acts for reach sessions, starts the person's program
    // from a locked phone.
    await expect(agentsRefresh(REFRESH, 'host', accounts)).rejects.toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    expect(accounts.calls).toEqual([])
  })

  it('read the figures with either token and refresh for the person', async () => {
    const accounts = new FakeAccounts(true)
    await expect(agentsAccounts(ACCOUNTS, accounts)).resolves.toEqual({ accounts: [], now: 1 })
    await expect(agentsRefresh(REFRESH, 'person', accounts)).resolves.toEqual({ outcome: { kind: 'checked' }, now: 1 })
    expect(accounts.calls).toEqual(['accounts', 'refresh codex signed-in'])
  })

  it('name a missing Host or account service as unavailable', async () => {
    await expect(agentsAccounts(ACCOUNTS, undefined)).rejects.toMatchObject({ code: 'AGENTS_UNAVAILABLE', detail: 'no Host is running' })
    await expect(agentsRefresh(REFRESH, 'person', undefined)).rejects.toMatchObject({ code: 'AGENTS_UNAVAILABLE' })
    const unloaded = new FakeAccounts(false)
    await expect(agentsAccounts(ACCOUNTS, unloaded)).rejects.toMatchObject({ code: 'AGENTS_UNAVAILABLE', detail: 'the running profile does not load external agents' })
    await expect(agentsRefresh(REFRESH, 'person', unloaded)).rejects.toMatchObject({ code: 'AGENTS_UNAVAILABLE' })
  })

  it('accept only a known agent and reason, and no other field', () => {
    const token = newStartToken()
    expect(checkUpdateRequest({ v: 1, token, op: 'agents.accounts' })).toMatchObject({ op: 'agents.accounts' })
    expect(checkUpdateRequest({ v: 1, token, op: 'agents.refresh', args: { provider: 'claude-code', reason: 'check-now' } })).toMatchObject({ args: { provider: 'claude-code' } })
    // Pins the closed schema: an agent outside the list, a reason a model could pick, or an extra field is refused.
    for (const bad of [
      { v: 1, token, op: 'agents.accounts', args: {} },
      { v: 1, token, op: 'agents.refresh', args: { provider: 'other', reason: 'check-now' } },
      { v: 1, token, op: 'agents.refresh', args: { provider: 'codex', reason: 'model-asked' } },
      { v: 1, token, op: 'agents.refresh', args: { provider: 'codex', reason: 'check-now', cwd: '/tmp' } },
      { v: 1, token, op: 'agents.refresh' },
    ]) expect(() => checkUpdateRequest(bad), JSON.stringify(bad.args)).toThrow(expect.objectContaining({ code: 'SCHEMA_VIOLATION' }))
  })
})
