// @vitest-environment jsdom
/**
 * The consent surfaces of the studio: the full-access consent that upstream's permission control asks before a chat
 * switches to full access in a workspace without a grant, the Workspace access section and the MCP servers section.
 * The denial cases prove that a remote studio, an unanswered consent and a stale review record nothing, and that a
 * profile without the consent plugins (such as one set up with "Same as stock") keeps upstream's behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { MCP_CONSENT_ROUTES } from '@delo/plugin-mcp-consent/wire'
import { PERMISSION_ROUTES } from '@delo/plugin-permission-defaults/wire'
import { en, zh } from '../src/client/consents-locales.ts'
import type { HostFetch } from '../src/client/host-api.ts'
import type { WorkspaceAccess } from '../src/client/consents-api.ts'
import {
  confirmPermissionSwitch, createFullAccessConsentSource, FullAccessConsent, FULL_ACCESS_COMMAND,
  type FullAccessConsentProps, type FullAccessConsentSource,
} from '../src/client/FullAccessConsent.tsx'
import { WorkspaceAccessSection, type WorkspaceAccessSectionProps } from '../src/client/WorkspaceAccessSection.tsx'
import { McpServersSection, type McpServersSectionProps } from '../src/client/McpServersSection.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** One scripted Host answer. */
type Answer = { status: number; body: unknown }

/** A route key: the method and the path. */
type RouteKey = `${'GET' | 'POST'} ${string}`

/**
 * A fake home answering each route with the latest scripted answer; an unscripted route answers 404, as a profile
 * without the route's plugin does.
 * @param script - the answers by route.
 * @returns the fake `fetch`, the received requests and the script.
 */
function fakeHost(script: Partial<Record<RouteKey, Answer>> = {}) {
  const received: { key: RouteKey; body: unknown }[] = []
  const fetch: HostFetch = async (input, init) => {
    const key: RouteKey = `${init?.method === 'POST' ? 'POST' : 'GET'} ${input}`
    received.push({ key, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    const answer = script[key] ?? { status: 404, body: { error: 'NOT_FOUND', message: 'No such route' } }
    return new Response(JSON.stringify(answer.body), { status: answer.status })
  }
  return { fetch, received, script }
}

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0)
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: NOW }) })

const OFF: WorkspaceAccess = { workspace: '/home/person/projects/site', title: 'site', preset: 'workspace-write', grantedAt: null, reviewId: 'a'.repeat(32) }
const ON: WorkspaceAccess = { ...OFF, preset: 'danger-full-access', grantedAt: NOW - 3_600_000, reviewId: 'b'.repeat(32) }
const refusal = (status: number, error: string, message = `${error} sentence`): Answer => ({ status, body: { error, message } })
const REMOTE = refusal(403, 'LOOPBACK_REQUIRED', 'Changing a workspace\'s full access needs you at your computer')

/** Let the answers a render waits for settle, inside React's act. */
const settle = (): Promise<void> => act(async () => {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
})

describe('the question upstream\'s permission control asks', () => {
  it('submits every switch but full access at once, without asking the home', async () => {
    const host = fakeHost()
    const ask = vi.fn(async () => true)
    await expect(confirmPermissionSwitch(host.fetch, { ask }, 'chat-1', 'workspace-write')).resolves.toBe(true)
    expect(host.received).toEqual([])
    expect(ask).not.toHaveBeenCalled()
  })

  it('submits at once in a profile without the per-workspace consent, as upstream does', async () => {
    const host = fakeHost()
    const ask = vi.fn(async () => true)
    await expect(confirmPermissionSwitch(host.fetch, { ask }, 'chat-1', 'danger-full-access')).resolves.toBe(true)
    expect(host.received.map(request => request.key)).toEqual([`POST ${PERMISSION_ROUTES.review}`])
    expect(ask).not.toHaveBeenCalled()
  })

  it('submits at once in a workspace that holds a grant, and in a chat with no folder', async () => {
    const ask = vi.fn(async () => true)
    const granted = fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: { status: 200, body: { access: ON } } })
    await expect(confirmPermissionSwitch(granted.fetch, { ask }, 'chat-1', 'danger-full-access')).resolves.toBe(true)
    const nowhere = fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: refusal(422, 'NO_WORKSPACE') })
    await expect(confirmPermissionSwitch(nowhere.fetch, { ask }, 'chat-1', 'danger-full-access')).resolves.toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('shows the consent for a workspace without a grant, and submits only what the person grants', async () => {
    const host = fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: { status: 200, body: { access: OFF } } })
    for (const granted of [true, false]) {
      const ask = vi.fn(async () => granted)
      await expect(confirmPermissionSwitch(host.fetch, { ask }, 'chat-1', 'danger-full-access')).resolves.toBe(granted)
      expect(ask).toHaveBeenCalledWith(OFF)
    }
    expect(host.received[0]?.body).toEqual({ sessionId: 'chat-1' })
  })

  it('shows a remote studio the consent without a way to grant, and submits nothing', async () => {
    const host = fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: REMOTE })
    const ask = vi.fn(async () => false)
    await expect(confirmPermissionSwitch(host.fetch, { ask }, 'chat-1', 'danger-full-access')).resolves.toBe(false)
    expect(ask).toHaveBeenCalledWith(undefined)
  })

  it('submits nothing when the home cannot answer the review', async () => {
    const host = fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: refusal(500, 'STORE_REFUSED') })
    await expect(confirmPermissionSwitch(host.fetch, { ask: vi.fn(async () => true) }, 'chat-1', 'danger-full-access')).rejects.toThrow('STORE_REFUSED')
  })
})

/**
 * Render the consent over its store.
 * @param source - the store.
 * @returns the render result.
 */
function renderConsent(source: FullAccessConsentSource) {
  const props = {
    t: makeTranslate(en), useConsent: <T,>(select: (state: ReturnType<FullAccessConsentSource['hooks']['consent']['getSnapshot']>) => T) => select(source.hooks.consent.getSnapshot()),
    confirm: source.confirm, cancel: source.cancel,
  } as FullAccessConsentProps
  return render(<FullAccessConsent {...props} />)
}

describe('the full-access consent', () => {
  it('names the folder, what full access reaches and that it covers this workspace only', async () => {
    const source = createFullAccessConsentSource(fakeHost().fetch)
    void source.ask(OFF)
    renderConsent(source)
    const dialog = screen.getByRole('dialog', { name: en['consent.title'] })
    expect(within(dialog).getByText(`site · ${OFF.workspace}`)).toBeTruthy()
    for (const key of ['consent.effect', 'consent.reach.files', 'consent.reach.keys', 'consent.reach.channels', 'consent.scope'] as const) {
      expect(within(dialog).getByText(en[key])).toBeTruthy()
    }
    expect(within(dialog).getByRole('button', { name: en['consent.confirm'] })).toBeTruthy()
  })

  it('records the grant with the review it showed and the person\'s answer, then closes', async () => {
    const host = fakeHost({ [`POST ${PERMISSION_ROUTES.setFullAccess}`]: { status: 200, body: { access: ON, chats: 0 } } })
    const source = createFullAccessConsentSource(host.fetch)
    const answered = source.ask(OFF)
    source.confirm()
    await expect(answered).resolves.toBe(true)
    expect(host.received).toEqual([{ key: `POST ${PERMISSION_ROUTES.setFullAccess}`, body: { workspace: OFF.workspace, reviewId: OFF.reviewId, on: true, confirmed: true } }])
    expect(source.hooks.consent.getSnapshot()).toBeNull()
  })

  it('records nothing when the person cancels, or asks again before answering', async () => {
    const host = fakeHost()
    const source = createFullAccessConsentSource(host.fetch)
    const first = source.ask(OFF)
    const second = source.ask(OFF)
    await expect(first).resolves.toBe(false)
    source.cancel()
    await expect(second).resolves.toBe(false)
    expect(host.received).toEqual([])
  })

  it('stays open with the stale review named when the workspace changed after it was shown', async () => {
    const host = fakeHost({ [`POST ${PERMISSION_ROUTES.setFullAccess}`]: refusal(409, 'STALE_REVIEW') })
    const source = createFullAccessConsentSource(host.fetch)
    void source.ask(OFF)
    source.confirm()
    await settle()
    expect(source.hooks.consent.getSnapshot()).toMatchObject({ busy: false, failure: { kind: 'stale' } })
    renderConsent(source)
    expect(screen.getByRole('alert').textContent).toBe(en['failed.stale'])
  })

  it('shows a remote studio the command for the home\'s computer and no way to grant', () => {
    const source = createFullAccessConsentSource(fakeHost().fetch)
    void source.ask(undefined)
    renderConsent(source)
    const dialog = screen.getByRole('dialog', { name: en['consent.title'] })
    expect(within(dialog).getByText(FULL_ACCESS_COMMAND)).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: en['consent.confirm'] })).toBeNull()
    source.confirm()
    expect(source.hooks.consent.getSnapshot()).not.toBeNull()
  })
})

/**
 * Render the Workspace access section over a fake home.
 * @param host - the fake home.
 * @param ask - the consent's question.
 * @returns the render result.
 */
function renderAccess(host: ReturnType<typeof fakeHost>, ask: FullAccessConsentSource['ask'] = async () => false) {
  const props = { t: makeTranslate(en), close: () => {}, fetch: host.fetch, ask } as WorkspaceAccessSectionProps
  return render(<WorkspaceAccessSection {...props} />)
}

describe('the Workspace access section', () => {
  it('lists each workspace with its full access, and asks the consent before turning it on', async () => {
    const host = fakeHost({ [`GET ${PERMISSION_ROUTES.workspaces}`]: { status: 200, body: { workspaces: [OFF] } } })
    const ask = vi.fn(async () => false)
    renderAccess(host, ask)
    await settle()
    expect(screen.getByText('site')).toBeTruthy()
    expect(screen.getByText(en['access.off'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['access.turnOn'] }))
    await settle()
    expect(ask).toHaveBeenCalledWith(OFF)
    expect(host.received.filter(request => request.key.startsWith('POST'))).toEqual([])
  })

  it('turns full access off with the person\'s answer and says how many open chats went back', async () => {
    const host = fakeHost({
      [`GET ${PERMISSION_ROUTES.workspaces}`]: { status: 200, body: { workspaces: [ON] } },
      [`POST ${PERMISSION_ROUTES.setFullAccess}`]: { status: 200, body: { access: { ...OFF, reviewId: 'c'.repeat(32) }, chats: 2 } },
    })
    renderAccess(host)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en['access.turnOff'] }))
    await settle()
    expect(host.received.find(request => request.key === `POST ${PERMISSION_ROUTES.setFullAccess}`)?.body)
      .toEqual({ workspace: ON.workspace, reviewId: ON.reviewId, on: false, confirmed: true })
    expect(screen.getByRole('status').textContent).toBe('Full access is off for site. Open chats set back to the safer preset: 2.')
  })

  it('tells a remote studio that the home\'s computer turns full access on and off', async () => {
    renderAccess(fakeHost({ [`GET ${PERMISSION_ROUTES.workspaces}`]: REMOTE }))
    await settle()
    expect(screen.getByRole('status').textContent).toContain(FULL_ACCESS_COMMAND)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says only that the profile does not ask, where the plugin is not mounted', async () => {
    renderAccess(fakeHost())
    await settle()
    expect(screen.getByText(en['access.unavailable'])).toBeTruthy()
  })
})

const SERVER = {
  serverName: 'files', reviewId: 'd'.repeat(32), command: 'npx', args: ['-y', 'server-filesystem'], cwd: '', envNames: ['API_TOKEN'],
  reason: 'the acceptance store holds no acceptance for this command', reviewedAt: NOW - 60_000,
}

/**
 * Render the MCP servers section over a fake home.
 * @param host - the fake home.
 * @returns the render result.
 */
function renderServers(host: ReturnType<typeof fakeHost>) {
  const props = { t: makeTranslate(en), close: () => {}, fetch: host.fetch } as McpServersSectionProps
  return render(<McpServersSection {...props} />)
}

describe('the MCP servers section', () => {
  it('shows what a waiting server would run, the names of its environment variables, and why it waits', async () => {
    renderServers(fakeHost({ [`GET ${MCP_CONSENT_ROUTES.pending}`]: { status: 200, body: { servers: [SERVER] } } }))
    await settle()
    const row = screen.getByText('files').closest('li')
    if (row === null) throw new Error('no row for the server')
    expect(within(row).getByText('npx')).toBeTruthy()
    expect(within(row).getByText('"-y" "server-filesystem"')).toBeTruthy()
    expect(within(row).getByText(en['mcp.cwdHost'])).toBeTruthy()
    expect(within(row).getByText('API_TOKEN')).toBeTruthy()
    expect(within(row).getByText(SERVER.reason)).toBeTruthy()
  })

  it('accepts a server only after the confirmation, with the review it showed and the person\'s answer', async () => {
    const host = fakeHost({
      [`GET ${MCP_CONSENT_ROUTES.pending}`]: { status: 200, body: { servers: [SERVER] } },
      [`POST ${MCP_CONSENT_ROUTES.accept}`]: { status: 200, body: { started: 1 } },
    })
    renderServers(host)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en['mcp.accept'] }))
    expect(host.received.filter(request => request.key.startsWith('POST'))).toEqual([])
    const dialog = screen.getByRole('dialog', { name: 'Start files outside the sandbox?' })
    fireEvent.click(within(dialog).getByRole('button', { name: en['mcp.confirm.accept'] }))
    await settle()
    expect(host.received.find(request => request.key === `POST ${MCP_CONSENT_ROUTES.accept}`)?.body)
      .toEqual({ serverName: 'files', reviewId: SERVER.reviewId, confirmed: true })
    expect(screen.getByRole('status').textContent).toBe('files is accepted and running.')
  })

  it('records nothing when the person cancels the confirmation, and names a stale review', async () => {
    const host = fakeHost({
      [`GET ${MCP_CONSENT_ROUTES.pending}`]: { status: 200, body: { servers: [SERVER] } },
      [`POST ${MCP_CONSENT_ROUTES.accept}`]: refusal(409, 'STALE_REVIEW'),
    })
    renderServers(host)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en['mcp.accept'] }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['mcp.confirm.cancel'] }))
    expect(host.received.filter(request => request.key.startsWith('POST'))).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: en['mcp.accept'] }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['mcp.confirm.accept'] }))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(en['failed.stale'])
  })

  it('declines a server, which stays stopped', async () => {
    const host = fakeHost({
      [`GET ${MCP_CONSENT_ROUTES.pending}`]: { status: 200, body: { servers: [SERVER] } },
      [`POST ${MCP_CONSENT_ROUTES.decline}`]: { status: 200, body: { declined: true } },
    })
    renderServers(host)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en['mcp.decline'] }))
    await settle()
    expect(host.received.find(request => request.key === `POST ${MCP_CONSENT_ROUTES.decline}`)?.body).toEqual({ serverName: 'files', reviewId: SERVER.reviewId })
    expect(screen.getByRole('status').textContent).toBe('files stays stopped.')
  })

  it('tells a remote studio to answer at the home\'s computer, and offers no answer', async () => {
    renderServers(fakeHost({ [`GET ${MCP_CONSENT_ROUTES.pending}`]: REMOTE }))
    await settle()
    expect(screen.getByRole('status').textContent).toContain('delorun mcp list')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says only that the profile does not ask, where the plugin is not mounted', async () => {
    renderServers(fakeHost())
    await settle()
    expect(screen.getByText(en['mcp.unavailable'])).toBeTruthy()
  })
})

describe('the consents copy', () => {
  it('has the same keys in English and Chinese', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
