// @vitest-environment jsdom
/**
 * The consent surfaces of the studio: the full-access consent that upstream's permission control asks before a chat
 * switches to full access in a workspace without a grant, the approval card's full-access action, the MCP server review,
 * the notice that a server waits, and the Permissions section with its revokes. The denial cases prove that a remote
 * studio, an unanswered consent and a stale review record nothing, that a phone sees "Approve this at your computer"
 * instead of a button, and that a profile without the consent plugins (such as one set up with "Same as stock") keeps
 * upstream's behaviour.
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
import { FullAccessAction, type FullAccessActionProps } from '../src/client/FullAccessAction.tsx'
import { createMcpReviewSource, McpServerReview, type McpReviewSource, type McpServerReviewProps } from '../src/client/McpServerReview.tsx'
import { McpWaitingNotice, type McpWaitingNoticeProps } from '../src/client/McpWaitingNotice.tsx'
import { MCP_COMMAND, PermissionsSection, type PermissionsSectionProps } from '../src/client/PermissionsSection.tsx'

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
  it('says in one sentence what it allows and in one its risk, with the folder and what it reaches under Details', async () => {
    const source = createFullAccessConsentSource(fakeHost().fetch)
    void source.ask(OFF)
    renderConsent(source)
    const dialog = screen.getByRole('dialog', { name: en['consent.title'] })
    expect(within(dialog).getByText(en['consent.allows'].replace('{workspace}', 'site'))).toBeTruthy()
    expect(within(dialog).getByText(en['consent.risk'])).toBeTruthy()
    const details = within(dialog).getByText(en['consent.details']).closest('details')
    if (details === null) throw new Error('no details')
    expect(details.open).toBe(false)
    expect(within(details).getByText(OFF.workspace)).toBeTruthy()
    for (const key of ['consent.reach.files', 'consent.reach.keys', 'consent.reach.channels', 'consent.scope'] as const) {
      expect(within(details).getByText(en[key])).toBeTruthy()
    }
    expect(within(dialog).getByRole('button', { name: en['consent.confirm'] })).toBeTruthy()
  })

  it('switches the chat it was asked from along with the grant', async () => {
    const host = fakeHost({ [`POST ${PERMISSION_ROUTES.setFullAccess}`]: { status: 200, body: { access: ON, chats: 1 } } })
    const source = createFullAccessConsentSource(host.fetch)
    const answered = source.ask(OFF, 'chat-1')
    source.confirm()
    await expect(answered).resolves.toBe(true)
    expect(host.received[0]?.body).toEqual({ workspace: OFF.workspace, reviewId: OFF.reviewId, on: true, confirmed: true, chat: 'chat-1' })
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

const SERVER = {
  serverName: 'files', reviewId: 'd'.repeat(32), command: 'npx', args: ['-y', 'server-filesystem'], cwd: '', envNames: ['API_TOKEN'],
  reason: 'the acceptance store holds no acceptance for this command', change: 'new' as const, reviewedAt: NOW - 60_000,
}
const ACCEPTED = { command: 'uvx', args: ['mcp-server-git'], cwd: '/srv/git', envNames: [], acceptedAt: NOW - 86_400_000, servers: ['git'] }
const SERVERS = (servers: readonly object[], accepted: readonly object[] = []): Answer => ({ status: 200, body: { servers, accepted } })

/**
 * The approval card's owner props and the action's face, over a fake home.
 * @param host - the fake home.
 * @param overrides - the props a case changes.
 * @returns the props.
 */
function actionProps(host: ReturnType<typeof fakeHost>, overrides: Partial<FullAccessActionProps> = {}): FullAccessActionProps {
  return {
    t: makeTranslate(en), grants: 'full-access', toolName: 'bash', callId: undefined, allow: vi.fn(async () => {}),
    sessionId: 'chat-1', fetch: host.fetch, ask: vi.fn(async () => true), ...overrides,
  } as FullAccessActionProps
}

describe('the approval card\'s full-access action', () => {
  it('offers to allow full access for the workspace, asks the consent once, then answers the card', async () => {
    const host = fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: { status: 200, body: { access: OFF } } })
    const props = actionProps(host)
    render(<FullAccessAction {...props} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en['action.allowFullAccess'] }))
    await settle()
    expect(props.ask).toHaveBeenCalledWith(OFF, 'chat-1')
    expect(props.allow).toHaveBeenCalledTimes(1)
  })

  it('leaves the card unanswered when the person cancels the consent', async () => {
    const host = fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: { status: 200, body: { access: OFF } } })
    const props = actionProps(host, { ask: vi.fn(async () => false) })
    render(<FullAccessAction {...props} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en['action.allowFullAccess'] }))
    await settle()
    expect(props.allow).not.toHaveBeenCalled()
  })

  it('does not ask again in a workspace that holds a grant: it switches the chat and answers the card', async () => {
    const host = fakeHost({
      [`POST ${PERMISSION_ROUTES.review}`]: { status: 200, body: { access: ON } },
      [`POST ${PERMISSION_ROUTES.setFullAccess}`]: { status: 200, body: { access: ON, chats: 1 } },
    })
    const props = actionProps(host)
    render(<FullAccessAction {...props} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en['action.allowFullAccess'] }))
    await settle()
    expect(props.ask).not.toHaveBeenCalled()
    expect(host.received.find(request => request.key === `POST ${PERMISSION_ROUTES.setFullAccess}`)?.body)
      .toEqual({ workspace: ON.workspace, reviewId: ON.reviewId, on: true, confirmed: true, chat: 'chat-1' })
    expect(props.allow).toHaveBeenCalledTimes(1)
  })

  it('tells a phone to approve at the computer, with no button', async () => {
    const props = actionProps(fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: REMOTE }))
    render(<FullAccessAction {...props} />)
    await settle()
    expect(screen.getByRole('status').textContent).toBe(en['action.atComputer'])
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows nothing for another grant, the consent\'s own card, a chat without a folder and a profile without the plugin', async () => {
    const reviewed = fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: { status: 200, body: { access: OFF } } })
    const cases = [
      actionProps(reviewed, { grants: 'workspace-management' }),
      actionProps(reviewed, { toolName: 'permission' }),
      actionProps(fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: refusal(422, 'NO_WORKSPACE') })),
      actionProps(fakeHost()),
    ]
    for (const props of cases) {
      const { container, unmount } = render(<FullAccessAction {...props} />)
      await settle()
      expect(container.innerHTML).toBe('')
      unmount()
    }
  })
})

/**
 * Render the MCP server review over its store.
 * @param source - the store.
 * @returns the render result.
 */
function renderReview(source: McpReviewSource) {
  const props = {
    t: makeTranslate(en), useReview: <T,>(select: (state: ReturnType<McpReviewSource['hooks']['review']['getSnapshot']>) => T) => select(source.hooks.review.getSnapshot()),
    confirm: source.confirm, cancel: source.cancel,
  } as McpServerReviewProps
  return render(<McpServerReview {...props} />)
}

describe('the MCP server review', () => {
  it('says what allowing does and its risk, with the start without an environment value under Details', () => {
    const source = createMcpReviewSource(fakeHost().fetch)
    void source.ask(SERVER)
    renderReview(source)
    const dialog = screen.getByRole('dialog', { name: 'Allow files to start?' })
    expect(within(dialog).getByText(en['mcp.confirm.allows'].replace('{server}', 'files'))).toBeTruthy()
    expect(within(dialog).getByText(en['mcp.confirm.risk'])).toBeTruthy()
    const details = within(dialog).getByText(en['mcp.details']).closest('details')
    if (details === null) throw new Error('no details')
    expect(within(details).getByText('npx')).toBeTruthy()
    expect(within(details).getByText('"-y" "server-filesystem"')).toBeTruthy()
    expect(within(details).getByText('API_TOKEN')).toBeTruthy()
    expect(dialog.textContent).not.toContain(SERVER.reason)
  })

  it('says what changed since the person allowed the server', () => {
    const source = createMcpReviewSource(fakeHost().fetch)
    void source.ask({ ...SERVER, change: 'environment' })
    renderReview(source)
    expect(screen.getByText(en['mcp.change.environment'])).toBeTruthy()
  })

  it('allows the start it showed with the person\'s answer, and records nothing when cancelled', async () => {
    const host = fakeHost({ [`POST ${MCP_CONSENT_ROUTES.accept}`]: { status: 200, body: { started: 1 } } })
    const source = createMcpReviewSource(host.fetch)
    const cancelled = source.ask(SERVER)
    source.cancel()
    await expect(cancelled).resolves.toBeUndefined()
    expect(host.received).toEqual([])
    const allowed = source.ask(SERVER)
    source.confirm()
    await expect(allowed).resolves.toBe(1)
    expect(host.received).toEqual([{ key: `POST ${MCP_CONSENT_ROUTES.accept}`, body: { serverName: 'files', reviewId: SERVER.reviewId, confirmed: true } }])
  })

  it('stays open with the stale review named', async () => {
    const source = createMcpReviewSource(fakeHost({ [`POST ${MCP_CONSENT_ROUTES.accept}`]: refusal(409, 'STALE_REVIEW') }).fetch)
    void source.ask(SERVER)
    source.confirm()
    await settle()
    renderReview(source)
    expect(screen.getByRole('alert').textContent).toBe(en['failed.stale'])
  })
})

/**
 * Render the waiting-server notice over a fake home.
 * @param host - the fake home.
 * @param review - the review's question.
 * @returns the render result.
 */
function renderNotice(host: ReturnType<typeof fakeHost>, review: McpReviewSource['ask'] = async () => undefined) {
  const props = { t: makeTranslate(en), fetch: host.fetch, review } as McpWaitingNoticeProps
  return render(<McpWaitingNotice {...props} />)
}

describe('the notice that an MCP server waits', () => {
  it('names the waiting server and opens its review from "Review and allow this server"', async () => {
    const review = vi.fn(async () => 1)
    renderNotice(fakeHost({ [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([SERVER]) }), review)
    await settle()
    expect(screen.getByText('An MCP server is waiting for your OK: files.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['mcp.notice.review'] }))
    expect(review).toHaveBeenCalledWith(SERVER)
  })

  it('tells a phone, which reads only the names, to approve at the computer', async () => {
    const host = fakeHost({ [`GET ${MCP_CONSENT_ROUTES.pending}`]: REMOTE, [`GET ${MCP_CONSENT_ROUTES.waiting}`]: { status: 200, body: { servers: [{ serverName: 'files', change: 'new' }] } } })
    renderNotice(host)
    await settle()
    expect(screen.getByText('An MCP server is waiting for your OK: files. Approve this at your computer.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: en['mcp.notice.review'] })).toBeNull()
  })

  it('shows nothing while no server waits, and in a profile without the plugin', async () => {
    for (const host of [fakeHost({ [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([]) }), fakeHost()]) {
      const { container, unmount } = renderNotice(host)
      await settle()
      expect(container.innerHTML).toBe('')
      unmount()
    }
  })
})

/**
 * Render the Permissions section over a fake home.
 * @param host - the fake home.
 * @param faces - the consent's and the review's questions.
 * @returns the render result.
 */
function renderPermissions(host: ReturnType<typeof fakeHost>, faces: Partial<Pick<PermissionsSectionProps, 'ask' | 'review'>> = {}) {
  const props = { t: makeTranslate(en), close: () => {}, fetch: host.fetch, ask: async () => false, review: async () => undefined, ...faces } as PermissionsSectionProps
  return render(<PermissionsSection {...props} />)
}

/**
 * The row of the section that names a text.
 * @param text - the text.
 * @returns the row.
 */
function rowOf(text: string): HTMLElement {
  const row = screen.getByText(text).closest('li')
  if (row === null) throw new Error(`no row for ${text}`)
  return row
}

describe('the Permissions section', () => {
  it('lists the workspaces that hold full access, with the others behind a disclosure that asks the consent', async () => {
    const other = { ...OFF, workspace: '/home/person/projects/notes', title: 'notes' }
    const ask = vi.fn(async () => false)
    renderPermissions(fakeHost({ [`GET ${PERMISSION_ROUTES.workspaces}`]: { status: 200, body: { workspaces: [ON, other] } } }), { ask })
    await settle()
    expect(within(rowOf('site')).getByRole('button', { name: en['access.revoke'] })).toBeTruthy()
    const others = screen.getByText('Other workspaces (1)').closest('details')
    if (others === null) throw new Error('no disclosure')
    expect(others.open).toBe(false)
    fireEvent.click(within(rowOf('notes')).getByRole('button', { name: en['access.allow'] }))
    await settle()
    expect(ask).toHaveBeenCalledWith(other)
  })

  it('revokes full access in one click, and says how many chats went back', async () => {
    const host = fakeHost({
      [`GET ${PERMISSION_ROUTES.workspaces}`]: { status: 200, body: { workspaces: [ON] } },
      [`POST ${PERMISSION_ROUTES.setFullAccess}`]: { status: 200, body: { access: { ...OFF, reviewId: 'c'.repeat(32) }, chats: 2 } },
    })
    renderPermissions(host)
    await settle()
    fireEvent.click(within(rowOf('site')).getByRole('button', { name: en['access.revoke'] }))
    await settle()
    expect(host.received.find(request => request.key === `POST ${PERMISSION_ROUTES.setFullAccess}`)?.body)
      .toEqual({ workspace: ON.workspace, reviewId: ON.reviewId, on: false, confirmed: true })
    expect(screen.getByRole('status').textContent).toBe('site is back on the safer preset. Chats switched back: 2.')
  })

  it('lists a waiting server with what changed, opens its review, and declines it in place', async () => {
    const review = vi.fn(async () => 1)
    const host = fakeHost({
      [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([{ ...SERVER, change: 'arguments' }]),
      [`POST ${MCP_CONSENT_ROUTES.decline}`]: { status: 200, body: { declined: true } },
    })
    renderPermissions(host, { review })
    await settle()
    const row = rowOf('files')
    expect(within(row).getByText(en['mcp.change.arguments'])).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: en['mcp.review'] }))
    await settle()
    expect(review).toHaveBeenCalledWith({ ...SERVER, change: 'arguments' })
    expect(screen.getByRole('status').textContent).toBe('files is allowed and running.')
    fireEvent.click(within(rowOf('files')).getByRole('button', { name: en['mcp.decline'] }))
    await settle()
    expect(host.received.find(request => request.key === `POST ${MCP_CONSENT_ROUTES.decline}`)?.body).toEqual({ serverName: 'files', reviewId: SERVER.reviewId })
  })

  it('lists an allowed server and revokes it in one click, saying how many servers stopped', async () => {
    const host = fakeHost({
      [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([], [ACCEPTED]),
      [`POST ${MCP_CONSENT_ROUTES.revoke}`]: { status: 200, body: { stopped: 1 } },
    })
    renderPermissions(host)
    await settle()
    const row = rowOf('git')
    expect(within(row).getByText('uvx')).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: en['mcp.revoke'] }))
    await settle()
    expect(host.received.find(request => request.key === `POST ${MCP_CONSENT_ROUTES.revoke}`)?.body).toEqual({ command: 'uvx', acceptedAt: ACCEPTED.acceptedAt, confirmed: true })
    expect(screen.getByRole('status').textContent).toBe('Revoked. Servers stopped: 1.')
  })

  it('names a stale revoke and keeps the grant listed', async () => {
    const host = fakeHost({
      [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([], [ACCEPTED]),
      [`POST ${MCP_CONSENT_ROUTES.revoke}`]: refusal(409, 'STALE_REVIEW'),
    })
    renderPermissions(host)
    await settle()
    fireEvent.click(within(rowOf('git')).getByRole('button', { name: en['mcp.revoke'] }))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(en['failed.stale'])
    expect(rowOf('git')).toBeTruthy()
  })

  it('tells a phone to approve at the computer, and offers no answer', async () => {
    renderPermissions(fakeHost({ [`GET ${PERMISSION_ROUTES.workspaces}`]: REMOTE, [`GET ${MCP_CONSENT_ROUTES.pending}`]: REMOTE }))
    await settle()
    const line = screen.getByRole('status').textContent
    expect(line).toContain(FULL_ACCESS_COMMAND)
    expect(line).toContain(MCP_COMMAND)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says only that the profile does not ask, where the plugins are not mounted', async () => {
    renderPermissions(fakeHost())
    await settle()
    expect(screen.getByText(en['access.unavailable'])).toBeTruthy()
    expect(screen.getByText(en['mcp.unavailable'])).toBeTruthy()
  })
})

describe('the consents copy', () => {
  it('has the same keys in English and Chinese', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
