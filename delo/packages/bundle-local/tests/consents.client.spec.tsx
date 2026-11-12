// @vitest-environment jsdom
/**
 * The consent surfaces of the studio: the full-access consent that upstream's permission control asks before a chat
 * switches to full access in a workspace without a grant, the approval card's full-access action, the MCP server review,
 * the notice that a server waits, the approval card's external-agent action, and the Permissions section with its revokes. The denial cases prove that a remote
 * studio, an unanswered consent and a stale review record nothing, that a phone sees "Approve this at your computer"
 * instead of a button, and that a profile without the consent plugins (such as one set up with "Same as stock") keeps
 * upstream's behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { MCP_CONSENT_ROUTES } from '@delo/plugin-mcp-consent/wire'
import { PERMISSION_ROUTES } from '@delo/plugin-permission-defaults/wire'
import { DELEGATION_CONSENT_ROUTES, type GrantView } from '@delo/plugin-delegation-consent/wire'
import { en, zh } from '../src/client/consents-locales.ts'
import type { HostFetch } from '../src/client/host-api.ts'
import type { WorkspaceAccess } from '../src/client/consents-api.ts'
import {
  confirmPermissionSwitch, consentFailureText, createFullAccessConsentSource, FullAccessConsent, FULL_ACCESS_COMMAND,
  workspaceName, type FullAccessConsentProps, type FullAccessConsentSource,
} from '../src/client/FullAccessConsent.tsx'
import { FullAccessAction, type FullAccessActionProps } from '../src/client/FullAccessAction.tsx'
import { agentOfferFor, ExternalAgentAction, type ExternalAgentActionProps } from '../src/client/ExternalAgentAction.tsx'
import { createMcpReviewSource, McpServerReview, serverChangeText, type McpReviewSource, type McpServerReviewProps } from '../src/client/McpServerReview.tsx'
import { McpWaitingNotice, type McpWaitingNoticeProps } from '../src/client/McpWaitingNotice.tsx'
import { AGENTS_COMMAND, MCP_COMMAND, PermissionsSection, type PermissionsSectionProps } from '../src/client/PermissionsSection.tsx'

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

  it('records nothing when the approval card it was asked from can no longer be answered at the confirm', async () => {
    const host = fakeHost({ [`POST ${PERMISSION_ROUTES.setFullAccess}`]: { status: 200, body: { access: ON, chats: 1 } } })
    const source = createFullAccessConsentSource(host.fetch)
    let answerable = true
    const answered = source.ask(OFF, 'chat-1', () => answerable)
    // The person rejects the card while the consent is open.
    answerable = false
    source.confirm()
    await expect(answered).resolves.toBe(false)
    expect(host.received).toEqual([])
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

  it('words a phone, a refusal and an unreachable home in the consent', async () => {
    const answers: [Answer | 'unreachable', string][] = [
      [REMOTE, en['loopback'].replace('{action}', en['action.changeAccess'])],
      [refusal(500, 'STORE_REFUSED', 'The record cannot be written'), 'The record cannot be written'],
      ['unreachable', en['failed.unreachable']],
    ]
    for (const [answer, text] of answers) {
      const host = fakeHost(answer === 'unreachable' ? {} : { [`POST ${PERMISSION_ROUTES.setFullAccess}`]: answer })
      const fetch: HostFetch = answer === 'unreachable' ? async () => Promise.reject(new TypeError('Failed to fetch')) : host.fetch
      const source = createFullAccessConsentSource(fetch)
      void source.ask(OFF)
      source.confirm()
      await settle()
      const { unmount } = renderConsent(source)
      expect(screen.getByRole('alert').textContent).toBe(text)
      unmount()
    }
    expect(consentFailureText(makeTranslate(en), { kind: 'remote' }, 'action.answerServer')).toBe(en['loopback'].replace('{action}', en['action.answerServer']))
  })

  it('tells subscribers of each change until they unsubscribe', () => {
    const source = createFullAccessConsentSource(fakeHost().fetch)
    const listener = vi.fn()
    const unsubscribe = source.hooks.consent.subscribe(listener)
    void source.ask(OFF)
    expect(listener).toHaveBeenCalled()
    const calls = listener.mock.calls.length
    unsubscribe()
    source.cancel()
    expect(listener).toHaveBeenCalledTimes(calls)
  })

  it('keeps a consent asked again while the first answer was recorded open, whatever that answer brought', async () => {
    for (const answer of [{ status: 200, body: { access: ON, chats: 0 } }, refusal(409, 'STALE_REVIEW')]) {
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => { release = resolve })
      const host = fakeHost({ [`POST ${PERMISSION_ROUTES.setFullAccess}`]: answer })
      const source = createFullAccessConsentSource(async (input, init) => { await held; return host.fetch(input, init) })
      const first = source.ask(OFF)
      source.confirm()
      const second = source.ask(ON)
      await expect(first).resolves.toBe(false)
      release()
      await settle()
      expect(source.hooks.consent.getSnapshot()).toMatchObject({ access: ON, busy: false })
      expect(source.hooks.consent.getSnapshot()).not.toHaveProperty('failure')
      source.cancel()
      await expect(second).resolves.toBe(false)
    }
  })

  it('names a workspace without a title by its folder\'s last segment, or by its whole path', () => {
    const { title: _title, ...untitled } = OFF
    expect(workspaceName(untitled)).toBe('site')
    expect(workspaceName({ ...untitled, workspace: '/' })).toBe('/')
  })

  it('shows nothing while no consent is open, and closes only while no answer is being recorded', async () => {
    const cancel = vi.fn()
    const open = (state: ReturnType<FullAccessConsentSource['hooks']['consent']['getSnapshot']>) => render(<FullAccessConsent {...{
      t: makeTranslate(en), useConsent: <T,>(select: (current: typeof state) => T) => select(state), confirm: () => {}, cancel,
    } as FullAccessConsentProps} />)
    const closed = open(null)
    expect(closed.container.innerHTML).toBe('')
    closed.unmount()
    const busy = open({ seq: 1, access: OFF, busy: true })
    fireEvent.click(screen.getByRole('button', { name: en['consent.close'] }))
    expect(cancel).not.toHaveBeenCalled()
    busy.unmount()
    open({ seq: 2, access: OFF, busy: false })
    fireEvent.click(screen.getByRole('button', { name: en['consent.close'] }))
    expect(cancel).toHaveBeenCalledTimes(1)
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
  serverName: 'files', reviewId: 'd'.repeat(32), command: 'npx', args: ['-y', 'server-filesystem'], cwd: '',
  resolvedCommand: '/usr/local/bin/npx', resolvedCwd: '/home/person',
  env: [{ name: 'API_TOKEN' }, { name: 'NODE_OPTIONS', value: '--require ./hook.js' }], changedVariables: [] as string[], state: 'waiting' as const,
  reason: 'the acceptance store holds no acceptance for this command', change: 'new' as const, reviewedAt: NOW - 60_000,
}
const ACCEPTED = {
  acceptanceId: 'e'.repeat(32), serverName: 'git', command: 'uvx', args: ['mcp-server-git'], cwd: '/srv/git',
  resolvedCommand: '/opt/uv/uvx.cmd', resolvedCwd: '/srv/git', resolvedShell: '/Windows/System32/cmd.exe', env: [], acceptedAt: NOW - 86_400_000, configured: true,
}
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
    answered: false, canAnswer: () => true, sessionId: 'chat-1', fetch: host.fetch, ask: vi.fn(async () => true), ...overrides,
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
    expect(props.ask).toHaveBeenCalledWith(OFF, 'chat-1', props.canAnswer)
    expect(props.allow).toHaveBeenCalledTimes(1)
  })

  it('is disabled once the card answered or no longer accepts an answer, so a click records nothing', async () => {
    for (const overrides of [{ answered: true }, { canAnswer: () => false }]) {
      const host = fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: { status: 200, body: { access: ON } } })
      const props = actionProps(host, overrides)
      const { unmount } = render(<FullAccessAction {...props} />)
      await settle()
      const button = screen.getByRole<HTMLButtonElement>('button', { name: en['action.allowFullAccess'] })
      expect(button.disabled).toBe(true)
      fireEvent.click(button)
      await settle()
      expect(host.received.map(request => request.key)).toEqual([`POST ${PERMISSION_ROUTES.review}`])
      expect(props.allow).not.toHaveBeenCalled()
      unmount()
    }
  })

  it('records nothing and reads nothing when the card no longer accepts an answer at the click', async () => {
    const host = fakeHost({
      [`POST ${PERMISSION_ROUTES.review}`]: { status: 200, body: { access: ON } },
      [`POST ${PERMISSION_ROUTES.setFullAccess}`]: { status: 200, body: { access: ON, chats: 1 } },
    })
    let answerable = true
    const props = actionProps(host, { canAnswer: () => answerable })
    render(<FullAccessAction {...props} />)
    await settle()
    // The request ended after the action rendered, so the card cannot answer, though no answer was sent from it.
    answerable = false
    fireEvent.click(screen.getByRole('button', { name: en['action.allowFullAccess'] }))
    await settle()
    expect(host.received.map(request => request.key)).toEqual([`POST ${PERMISSION_ROUTES.review}`])
    expect(props.ask).not.toHaveBeenCalled()
    expect(props.allow).not.toHaveBeenCalled()
  })

  it('records nothing when the person answers the card while the click reads the workspace', async () => {
    for (const access of [ON, OFF]) {
      const host = fakeHost({
        [`POST ${PERMISSION_ROUTES.review}`]: { status: 200, body: { access } },
        [`POST ${PERMISSION_ROUTES.setFullAccess}`]: { status: 200, body: { access: ON, chats: 1 } },
      })
      let answerable = true
      let clicked = false
      const fetch: HostFetch = async (input, init) => {
        const response = await host.fetch(input, init)
        // The person rejects the card while the click's review is on its way.
        if (clicked) answerable = false
        return response
      }
      const props = actionProps(host, { fetch, canAnswer: () => answerable })
      const { unmount } = render(<FullAccessAction {...props} />)
      await settle()
      clicked = true
      fireEvent.click(screen.getByRole('button', { name: en['action.allowFullAccess'] }))
      await settle()
      expect(host.received.map(request => request.key)).toEqual([`POST ${PERMISSION_ROUTES.review}`, `POST ${PERMISSION_ROUTES.review}`])
      expect(props.ask).not.toHaveBeenCalled()
      expect(props.allow).not.toHaveBeenCalled()
      unmount()
    }
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

  it('answers the workspace\'s full access as the home holds it at the click, not as it was shown', async () => {
    const host = fakeHost({
      [`POST ${PERMISSION_ROUTES.review}`]: { status: 200, body: { access: OFF } },
      [`POST ${PERMISSION_ROUTES.setFullAccess}`]: { status: 200, body: { access: ON, chats: 1 } },
    })
    const props = actionProps(host)
    render(<FullAccessAction {...props} />)
    await settle()
    // Another surface granted full access after the card was shown.
    host.script[`POST ${PERMISSION_ROUTES.review}`] = { status: 200, body: { access: ON } }
    fireEvent.click(screen.getByRole('button', { name: en['action.allowFullAccess'] }))
    await settle()
    expect(props.ask).not.toHaveBeenCalled()
    expect(host.received.find(request => request.key === `POST ${PERMISSION_ROUTES.setFullAccess}`)?.body)
      .toEqual({ workspace: ON.workspace, reviewId: ON.reviewId, on: true, confirmed: true, chat: 'chat-1' })
    expect(props.allow).toHaveBeenCalledTimes(1)
  })

  it('names a grant the home refused, and leaves the card unanswered', async () => {
    const host = fakeHost({
      [`POST ${PERMISSION_ROUTES.review}`]: { status: 200, body: { access: ON } },
      [`POST ${PERMISSION_ROUTES.setFullAccess}`]: refusal(409, 'STALE_REVIEW'),
    })
    const props = actionProps(host)
    render(<FullAccessAction {...props} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en['action.allowFullAccess'] }))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(en['failed.stale'])
    expect(props.allow).not.toHaveBeenCalled()
  })

  it('shows nothing when the card goes away before the home answers its review', async () => {
    const host = fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: { status: 200, body: { access: OFF } } })
    const { container, unmount } = render(<FullAccessAction {...actionProps(host)} />)
    unmount()
    await settle()
    expect(container.innerHTML).toBe('')
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

const GRANT: GrantView = { workspace: '/home/person/projects/site', provider: 'claude-code', agent: 'Claude Code', grantedAt: NOW - 3_600_000 }
const GRANTS = (grants: readonly GrantView[], storeProblem?: string): Answer => ({ status: 200, body: storeProblem === undefined ? { grants } : { grants, storeProblem } })

/**
 * The approval card's owner props and the external-agent action's face, over a fake home.
 * @param host - the fake home.
 * @param overrides - the props a case changes.
 * @returns the props.
 */
function agentActionProps(host: ReturnType<typeof fakeHost>, overrides: Partial<ExternalAgentActionProps> = {}): ExternalAgentActionProps {
  return {
    t: makeTranslate(en), grants: 'external-agent', toolName: 'claude-code', callId: undefined, allow: vi.fn(async () => {}),
    answered: false, canAnswer: () => true, sessionId: 'chat-1', fetch: host.fetch, ...overrides,
  } as ExternalAgentActionProps
}

describe('the approval card\'s external-agent action', () => {
  it('records the workspace grant first, then answers the card', async () => {
    const host = fakeHost({
      [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([]),
      [`POST ${DELEGATION_CONSENT_ROUTES.allow}`]: { status: 200, body: { grant: GRANT } },
    })
    const props = agentActionProps(host)
    render(<ExternalAgentAction {...props} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en['action.allowAgent'] }))
    await settle()
    expect(host.received.find(request => request.key === `POST ${DELEGATION_CONSENT_ROUTES.allow}`)?.body)
      .toEqual({ sessionId: 'chat-1', provider: 'claude-code', confirmed: true })
    expect(props.allow).toHaveBeenCalledTimes(1)
  })

  it('is disabled once the card answered or no longer accepts an answer, so a click records nothing', async () => {
    for (const overrides of [{ answered: true }, { canAnswer: () => false }]) {
      const host = fakeHost({
        [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([]),
        [`POST ${DELEGATION_CONSENT_ROUTES.allow}`]: { status: 200, body: { grant: GRANT } },
      })
      const props = agentActionProps(host, overrides)
      const { unmount } = render(<ExternalAgentAction {...props} />)
      await settle()
      const button = screen.getByRole<HTMLButtonElement>('button', { name: en['action.allowAgent'] })
      expect(button.disabled).toBe(true)
      fireEvent.click(button)
      await settle()
      expect(host.received.map(request => request.key)).toEqual([`GET ${DELEGATION_CONSENT_ROUTES.grants}`])
      expect(props.allow).not.toHaveBeenCalled()
      unmount()
    }
  })

  it('records nothing when the card no longer accepts an answer at the click', async () => {
    const host = fakeHost({
      [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([]),
      [`POST ${DELEGATION_CONSENT_ROUTES.allow}`]: { status: 200, body: { grant: GRANT } },
    })
    let answerable = true
    const props = agentActionProps(host, { canAnswer: () => answerable })
    render(<ExternalAgentAction {...props} />)
    await settle()
    // The request ended after the action rendered, so the card cannot answer, though no answer was sent from it.
    answerable = false
    fireEvent.click(screen.getByRole('button', { name: en['action.allowAgent'] }))
    await settle()
    expect(host.received.map(request => request.key)).toEqual([`GET ${DELEGATION_CONSENT_ROUTES.grants}`])
    expect(props.allow).not.toHaveBeenCalled()
  })

  it('does not answer a card that stopped accepting an answer while the grant was recorded', async () => {
    const host = fakeHost({
      [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([]),
      [`POST ${DELEGATION_CONSENT_ROUTES.allow}`]: { status: 200, body: { grant: GRANT } },
    })
    let answerable = true
    const fetch: HostFetch = async (input, init) => {
      const response = await host.fetch(input, init)
      // The person rejects the card while the grant is on its way.
      if (init?.method === 'POST') answerable = false
      return response
    }
    const props = agentActionProps(host, { fetch, canAnswer: () => answerable })
    render(<ExternalAgentAction {...props} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en['action.allowAgent'] }))
    await settle()
    expect(host.received.map(request => request.key)).toEqual([`GET ${DELEGATION_CONSENT_ROUTES.grants}`, `POST ${DELEGATION_CONSENT_ROUTES.allow}`])
    expect(props.allow).not.toHaveBeenCalled()
  })

  it('leaves the card unanswered and names the reason when the home records nothing', async () => {
    const host = fakeHost({
      [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([]),
      [`POST ${DELEGATION_CONSENT_ROUTES.allow}`]: refusal(500, 'STORE_REFUSED', 'The approvals file cannot be changed'),
    })
    const props = agentActionProps(host)
    render(<ExternalAgentAction {...props} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en['action.allowAgent'] }))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('The approvals file cannot be changed')
    expect(props.allow).not.toHaveBeenCalled()
  })

  it('leaves the card unanswered when the home refuses the grant as remote at the click', async () => {
    const host = fakeHost({
      [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([]),
      [`POST ${DELEGATION_CONSENT_ROUTES.allow}`]: REMOTE,
    })
    const props = agentActionProps(host)
    render(<ExternalAgentAction {...props} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en['action.allowAgent'] }))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(makeTranslate(en)('loopback', { action: en['action.changeAgent'] }))
    expect(props.allow).not.toHaveBeenCalled()
  })

  it('tells a phone to approve at the computer, with no button', async () => {
    const props = agentActionProps(fakeHost({ [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: REMOTE }))
    render(<ExternalAgentAction {...props} />)
    await settle()
    expect(screen.getByRole('status').textContent).toBe(en['action.atComputer'])
    expect(screen.queryByRole('button')).toBeNull()
    expect(props.allow).not.toHaveBeenCalled()
  })

  it('shows nothing for another grant, a card without a tool, a profile without the plugin and an unreadable home', async () => {
    const mounted = fakeHost({ [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([]) })
    const cases = [
      agentActionProps(mounted, { grants: 'full-access' }),
      agentActionProps(mounted, { toolName: undefined }),
      agentActionProps(fakeHost()),
      agentActionProps(fakeHost({ [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: refusal(500, 'STORE_REFUSED') })),
    ]
    for (const props of cases) {
      const { container, unmount } = render(<ExternalAgentAction {...props} />)
      await settle()
      expect(container.innerHTML).toBe('')
      unmount()
    }
  })

  it('reads its offer from the grants route', async () => {
    await expect(agentOfferFor(fakeHost({ [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([GRANT]) }).fetch)).resolves.toBe('allow')
    await expect(agentOfferFor(fakeHost({ [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: REMOTE }).fetch)).resolves.toBe('remote')
    await expect(agentOfferFor(fakeHost().fetch)).resolves.toBe('none')
  })

  it('ignores an offer that arrives after the card is gone', async () => {
    let answer: ((response: Response) => void) | undefined
    const fetch: HostFetch = async () => new Promise<Response>((resolve) => { answer = resolve })
    const { container, unmount } = render(<ExternalAgentAction {...agentActionProps({ fetch, received: [], script: {} })} />)
    unmount()
    answer?.(new Response(JSON.stringify({ grants: [] }), { status: 200 }))
    await settle()
    expect(container.innerHTML).toBe('')
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
    // A value shows only where it changes what runs.
    expect(within(details).getByText((_content, element) => element?.tagName === 'CODE' && element.textContent === 'API_TOKEN\nNODE_OPTIONS=--require ./hook.js')).toBeTruthy()
    expect(dialog.textContent).not.toContain(SERVER.reason)
  })

  it('names the file that runs and the folder it runs in before the person allows it, and lists them under Details', () => {
    const source = createMcpReviewSource(fakeHost().fetch)
    void source.ask(SERVER)
    renderReview(source)
    const dialog = screen.getByRole('dialog', { name: 'Allow files to start?' })
    expect(within(dialog).getByText('It runs /usr/local/bin/npx in /home/person.')).toBeTruthy()
    const details = within(dialog).getByText(en['mcp.details']).closest('details')
    if (details === null) throw new Error('no details')
    expect(within(details).getByText('/usr/local/bin/npx')).toBeTruthy()
    expect(within(details).getByText('/home/person')).toBeTruthy()
    expect(within(details).queryByText(en['mcp.resolvedShell'])).toBeNull()
  })

  it('names the command shell that runs a batch file', () => {
    const source = createMcpReviewSource(fakeHost().fetch)
    void source.ask({ ...SERVER, resolvedCommand: '/nodejs/npx.cmd', resolvedShell: '/Windows/System32/cmd.exe' })
    renderReview(source)
    const dialog = screen.getByRole('dialog', { name: 'Allow files to start?' })
    expect(within(dialog).getByText('It runs /nodejs/npx.cmd through /Windows/System32/cmd.exe in /home/person.')).toBeTruthy()
    expect(within(dialog).getByText(en['mcp.resolvedShell'])).toBeTruthy()
    expect(within(dialog).getByText('/Windows/System32/cmd.exe')).toBeTruthy()
  })

  it('says what changed since the person allowed the server', () => {
    const source = createMcpReviewSource(fakeHost().fetch)
    void source.ask({ ...SERVER, change: 'environment', changedVariables: ['NODE_OPTIONS', 'PATH'] })
    renderReview(source)
    expect(screen.getByText('Its environment variables changed since you allowed it: NODE_OPTIONS, PATH.')).toBeTruthy()
  })

  it('says in its own words what each review asks about', () => {
    const t = makeTranslate(en)
    for (const change of ['new', 'command', 'arguments', 'directory', 'resolved', 'unreadable', 'upgraded'] as const) {
      expect(serverChangeText(t, { change, changedVariables: [] })).toBe(en[`mcp.change.${change}`])
    }
  })

  it('shows nothing while no review is open, and None for a start without arguments', () => {
    const source = createMcpReviewSource(fakeHost().fetch)
    const { container } = renderReview(source)
    expect(container.innerHTML).toBe('')
    void source.ask({ ...SERVER, args: [] })
    renderReview(source)
    const details = screen.getByText(en['mcp.details']).closest('details')
    if (details === null) throw new Error('no details')
    expect(within(details).getAllByText(en['mcp.argsNone']).length).toBeGreaterThan(0)
  })

  it('tells subscribers of each change, and ignores a second confirm and a closed review\'s answer', async () => {
    let answer: (response: Response) => void = () => {}
    const source = createMcpReviewSource(async () => new Promise<Response>((resolve) => { answer = resolve }))
    const listener = vi.fn()
    const unsubscribe = source.hooks.review.subscribe(listener)
    source.confirm()
    expect(listener).not.toHaveBeenCalled()
    // Asking closes any open review first, then opens this one.
    const asked = source.ask(SERVER)
    expect(listener).toHaveBeenCalledTimes(2)
    source.confirm()
    source.confirm()
    expect(listener).toHaveBeenCalledTimes(3)
    // The review closes before its answer arrives: the late answer changes nothing.
    source.cancel()
    await expect(asked).resolves.toBeUndefined()
    answer(new Response(JSON.stringify({ started: 1 }), { status: 200 }))
    await settle()
    expect(source.hooks.review.getSnapshot()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(4)
    unsubscribe()
    void source.ask(SERVER)
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('keeps a refusal of a review closed meanwhile out of the next review', async () => {
    let refuse: (response: Response) => void = () => {}
    const source = createMcpReviewSource(async () => new Promise<Response>((resolve) => { refuse = resolve }))
    void source.ask(SERVER)
    source.confirm()
    void source.ask({ ...SERVER, serverName: 'other' })
    refuse(new Response(JSON.stringify({ error: 'STALE_REVIEW', message: 'stale' }), { status: 409 }))
    await settle()
    expect(source.hooks.review.getSnapshot()).toMatchObject({ server: { serverName: 'other' }, busy: false })
    expect(source.hooks.review.getSnapshot()?.failure).toBeUndefined()
  })

  it('says when the command or folder now points to a different place', () => {
    const source = createMcpReviewSource(fakeHost().fetch)
    void source.ask({ ...SERVER, change: 'resolved', resolvedCommand: '/home/person/node_modules/.bin/npx' })
    renderReview(source)
    expect(screen.getByText(en['mcp.change.resolved'])).toBeTruthy()
    expect(screen.getByText('It runs /home/person/node_modules/.bin/npx in /home/person.')).toBeTruthy()
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

  it('keeps Cancel disabled while the answer is recorded', async () => {
    const source = createMcpReviewSource(async () => new Promise<Response>(() => {}))
    void source.ask(SERVER)
    source.confirm()
    renderReview(source)
    const cancel = screen.getByRole('button', { name: en['mcp.confirm.cancel'] })
    expect((cancel as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(cancel)
    expect(source.hooks.review.getSnapshot()).not.toBeNull()
    // The dialog's own close control does not close it either while the answer is recorded.
    fireEvent.click(screen.getByRole('button', { name: en['mcp.confirm.close'] }))
    expect(source.hooks.review.getSnapshot()).not.toBeNull()
  })

  it('closes from its own close control when no answer is being recorded, recording nothing', async () => {
    const host = fakeHost()
    const source = createMcpReviewSource(host.fetch)
    const asked = source.ask(SERVER)
    renderReview(source)
    fireEvent.click(screen.getByRole('button', { name: en['mcp.confirm.close'] }))
    await expect(asked).resolves.toBeUndefined()
    expect(host.received).toEqual([])
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
  const notify = vi.fn<McpWaitingNoticeProps['notify']>()
  const props = { t: makeTranslate(en), fetch: host.fetch, review, notify } as McpWaitingNoticeProps
  return { notify, ...render(<McpWaitingNotice {...props} />) }
}

describe('the notice that an MCP server waits', () => {
  it('names the waiting server and opens its review from "Review and allow this server"', async () => {
    const review = vi.fn(async () => 1)
    const { notify } = renderNotice(fakeHost({ [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([SERVER]) }), review)
    await settle()
    expect(screen.getByText('An MCP server is waiting for your OK: files.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['mcp.notice.review'] }))
    expect(review).toHaveBeenCalledWith(SERVER)
    await settle()
    // Allowing from the notice says so, as an answer in Settings does.
    expect(notify).toHaveBeenCalledWith('files is allowed and running.', false)
  })

  it('offers each waiting server in turn, and none that the person declined or revoked', async () => {
    const other = { ...SERVER, serverName: 'git', reviewId: 'f'.repeat(32) }
    const review = vi.fn(async () => undefined)
    renderNotice(fakeHost({ [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([SERVER, other, { ...SERVER, serverName: 'old', state: 'declined' }]) }), review)
    await settle()
    expect(screen.getByText('An MCP server is waiting for your OK: files, git.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['mcp.notice.review'] }))
    await settle()
    expect(review).toHaveBeenLastCalledWith(SERVER)
    expect(screen.getByText('An MCP server is waiting for your OK: git.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['mcp.notice.review'] }))
    await settle()
    expect(review).toHaveBeenLastCalledWith(other)
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
    // A grant makes the workspace's new chats start with full access, which the row says.
    expect(within(rowOf('site')).getByText(en['access.newChats'])).toBeTruthy()
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
    // The outcome belongs to the section, not to the row the list's refresh removes.
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
    // What runs: the resolved batch file, the command shell that runs it, and the folder.
    expect(within(row).getByText('/opt/uv/uvx.cmd')).toBeTruthy()
    expect(within(row).getByText('/Windows/System32/cmd.exe')).toBeTruthy()
    expect(within(row).getAllByText('/srv/git')).toHaveLength(2)
    fireEvent.click(within(row).getByRole('button', { name: en['mcp.revoke'] }))
    await settle()
    expect(host.received.find(request => request.key === `POST ${MCP_CONSENT_ROUTES.revoke}`)?.body).toEqual({ acceptanceId: ACCEPTED.acceptanceId, confirmed: true })
    expect(screen.getByRole('status').textContent).toBe('Revoked. Servers stopped: 1.')
  })

  it('reads a pending list whose entries lack the resolved paths as unreadable, showing no start', async () => {
    const { resolvedCommand: _command, ...unresolved } = SERVER
    renderPermissions(fakeHost({ [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([unresolved]) }))
    await settle()
    expect(screen.queryByText('npx')).toBeNull()
    expect(document.querySelector('[data-server="files"]')).toBeNull()
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

  it('lists each external agent allowed per workspace and revokes it in one click', async () => {
    const host = fakeHost({
      [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([GRANT]),
      [`POST ${DELEGATION_CONSENT_ROUTES.revoke}`]: { status: 200, body: { revoked: true } },
    })
    renderPermissions(host)
    await settle()
    const row = rowOf('Claude Code')
    expect(within(row).getByText(GRANT.workspace)).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: en['agents.revoke'] }))
    await settle()
    expect(host.received.find(request => request.key === `POST ${DELEGATION_CONSENT_ROUTES.revoke}`)?.body).toEqual({ workspace: GRANT.workspace, provider: 'claude-code' })
    expect(screen.getByRole('status').textContent).toBe(`Claude Code asks again before it starts in ${GRANT.workspace}.`)
  })

  it('says no agent starts without asking, and names a grants file it cannot read', async () => {
    renderPermissions(fakeHost({ [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([], 'not JSON') }))
    await settle()
    expect(screen.getByText(en['agents.none'])).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe(makeTranslate(en)('agents.storeProblem', { problem: 'not JSON' }))
  })

  it('names a refused revoke and keeps the grant listed', async () => {
    const host = fakeHost({
      [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([GRANT]),
      [`POST ${DELEGATION_CONSENT_ROUTES.revoke}`]: REMOTE,
    })
    renderPermissions(host)
    await settle()
    fireEvent.click(within(rowOf('Claude Code')).getByRole('button', { name: en['agents.revoke'] }))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(makeTranslate(en)('loopback', { action: en['action.changeAgent'] }))
    expect(rowOf('Claude Code')).toBeTruthy()
  })

  it('tells a phone to approve at the computer, and offers no answer', async () => {
    renderPermissions(fakeHost({ [`GET ${PERMISSION_ROUTES.workspaces}`]: REMOTE, [`GET ${MCP_CONSENT_ROUTES.pending}`]: REMOTE, [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: REMOTE }))
    await settle()
    const line = screen.getByRole('status').textContent
    expect(line).toContain(FULL_ACCESS_COMMAND)
    expect(line).toContain(MCP_COMMAND)
    expect(line).toContain(AGENTS_COMMAND)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('lists a declined or revoked server apart from the waiting ones, still allowable', async () => {
    const review = vi.fn(async () => 1)
    renderPermissions(fakeHost({ [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([{ ...SERVER, state: 'revoked' }]) }), { review })
    await settle()
    expect(screen.queryByText(en['mcp.waiting'])).toBeNull()
    const row = rowOf('files')
    expect(within(row).getByText(en['mcp.state.revoked'])).toBeTruthy()
    expect(within(row).queryByRole('button', { name: en['mcp.decline'] })).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: en['mcp.allow'] }))
    expect(review).toHaveBeenCalledWith({ ...SERVER, state: 'revoked' })
  })

  it('names a store it cannot read, and says when nothing is allowed or waiting', async () => {
    renderPermissions(fakeHost({
      [`GET ${PERMISSION_ROUTES.workspaces}`]: { status: 200, body: { workspaces: [], storeProblem: 'the file is not JSON' } },
      [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([]),
    }))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(en['access.storeProblem'].replace('{problem}', 'the file is not JSON'))
    expect(screen.getByText(en['access.none'])).toBeTruthy()
    expect(screen.getByText(en['mcp.none'])).toBeTruthy()
  })

  it('says a reviewed server starts later or was not answered, names a declined one, and marks an allowed start no server uses', async () => {
    const review = vi.fn<() => Promise<number | undefined>>(async () => 0)
    renderPermissions(fakeHost({
      [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([{ ...SERVER, state: 'declined' }], [{ ...ACCEPTED, configured: false }]),
    }), { review })
    await settle()
    expect(within(rowOf('files')).getByText(en['mcp.state.declined'])).toBeTruthy()
    expect(within(rowOf('git')).getByText(en['mcp.unused'])).toBeTruthy()
    fireEvent.click(within(rowOf('files')).getByRole('button', { name: en['mcp.allow'] }))
    await settle()
    expect(screen.getByRole('status').textContent).toBe(en['mcp.acceptedLater'].replace('{server}', 'files'))
    review.mockResolvedValueOnce(undefined)
    fireEvent.click(within(rowOf('files')).getByRole('button', { name: en['mcp.allow'] }))
    await settle()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says it is loading until each list answers', async () => {
    renderPermissions({ fetch: async () => new Promise<Response>(() => {}), received: [], script: {} })
    await settle()
    expect(screen.getAllByText(en['permissions.loading'])).toHaveLength(3)
  })

  it('says only that the profile does not ask, where the plugins are not mounted', async () => {
    renderPermissions(fakeHost())
    await settle()
    expect(screen.getByText(en['access.unavailable'])).toBeTruthy()
    expect(screen.getByText(en['mcp.unavailable'])).toBeTruthy()
    expect(screen.getByText(en['agents.unavailable'])).toBeTruthy()
  })
})

describe('the consents copy', () => {
  it('has the same keys in English and Chinese', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
