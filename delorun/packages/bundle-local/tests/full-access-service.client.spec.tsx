// @vitest-environment jsdom
/**
 * `ctx.delorunFullAccess.askForWorkspace`, which the new-workspace flow calls when the person picks Full access: it shows
 * the one existing full-access consent for that workspace and records nothing itself. The denial cases prove that a
 * workspace the home does not list, a remote studio, a profile without the per-workspace consent and a cancelled consent
 * grant nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import { PERMISSION_ROUTES } from '@delorun/plugin-permission-defaults/wire'
import type { FullAccessConsentSource, SwitchAnswer } from '../src/client/FullAccessConsent.tsx'
import type { WorkspaceAccess } from '../src/client/consents-api.ts'
import type { HostFetch } from '../src/client/host-api.ts'
import { askForWorkspace } from '../src/client/index.ts'

const PATH = '/home/person/src/site'
const OFF: WorkspaceAccess = { workspace: PATH, title: 'site', preset: 'workspace-write', grantedAt: null, reviewId: 'a'.repeat(32) }
const ON: WorkspaceAccess = { ...OFF, preset: 'danger-full-access', grantedAt: 1_700_000_000_000, reviewId: 'b'.repeat(32) }
const OTHER: WorkspaceAccess = { ...OFF, workspace: '/home/person/src/other', title: 'other' }

/**
 * A home answering the workspaces list as given; every other request is a 404, as a profile without the route's plugin.
 * @param answer - the list's status and body.
 * @returns the fake fetch and the requests it saw.
 */
function home(answer: { readonly status: number, readonly body: unknown }) {
  const received: string[] = []
  const fetch: HostFetch = async (input, init) => {
    received.push(`${init?.method ?? 'GET'} ${String(input)}`)
    if (String(input) === PERMISSION_ROUTES.workspaces) return new Response(JSON.stringify(answer.body), { status: answer.status })
    return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 })
  }
  return { fetch, received }
}

/**
 * A consent whose answer the spec gives.
 * @param answer - what the person answers.
 * @returns the consent's `ask` and `askSwitch` calls.
 */
function consent(answer: boolean) {
  const ask = vi.fn(async (_access: WorkspaceAccess | undefined) => answer)
  const askSwitch = vi.fn(async (): Promise<SwitchAnswer> => answer ? 'submit' : 'cancelled')
  return { source: { ask, askSwitch } as Pick<FullAccessConsentSource, 'ask' | 'askSwitch'> as FullAccessConsentSource, ask, askSwitch }
}

describe('the full-access consent for one workspace', () => {
  it('shows the existing consent for the workspace at the folder, and answers what the person answered', async () => {
    for (const answer of [true, false]) {
      const host = home({ status: 200, body: { workspaces: [OTHER, OFF], everywhere: { on: false } } })
      const asked = consent(answer)
      await expect(askForWorkspace(host.fetch, asked.source, PATH)).resolves.toBe(answer)
      expect(asked.ask.mock.calls).toEqual([[OFF]])
      expect(asked.askSwitch).not.toHaveBeenCalled()
      expect(host.received).toEqual([`GET ${PERMISSION_ROUTES.workspaces}`])
    }
  })

  it('asks nothing for a workspace that already holds full access', async () => {
    const asked = consent(false)
    await expect(askForWorkspace(home({ status: 200, body: { workspaces: [ON], everywhere: { on: false } } }).fetch, asked.source, PATH)).resolves.toBe(true)
    expect(asked.ask).not.toHaveBeenCalled()
  })

  it('grants nothing and asks nothing for a folder the home does not list', async () => {
    const asked = consent(true)
    await expect(askForWorkspace(home({ status: 200, body: { workspaces: [OTHER], everywhere: { on: false } } }).fetch, asked.source, PATH)).resolves.toBe(false)
    expect(asked.ask).not.toHaveBeenCalled()
  })

  it('shows the remote form, which records nothing, when the home refuses the list to this studio', async () => {
    const asked = consent(false)
    const remote = home({ status: 403, body: { error: 'LOOPBACK_REQUIRED', message: 'Changing a workspace\'s full access needs you at your computer' } })
    await expect(askForWorkspace(remote.fetch, asked.source, PATH)).resolves.toBe(false)
    expect(asked.ask.mock.calls).toEqual([[undefined]])
  })

  it('grants nothing and asks nothing in a profile without the per-workspace consent', async () => {
    const asked = consent(true)
    await expect(askForWorkspace(home({ status: 404, body: { error: 'NOT_FOUND' } }).fetch, asked.source, PATH)).resolves.toBe(false)
    expect(asked.ask).not.toHaveBeenCalled()
  })

  it('reports a list the home cannot give for another reason instead of asking', async () => {
    const asked = consent(true)
    await expect(askForWorkspace(home({ status: 500, body: { error: 'STORE_REFUSED', message: 'The permission store cannot be read' } }).fetch, asked.source, PATH)).rejects.toThrow()
    expect(asked.ask).not.toHaveBeenCalled()
  })
})
