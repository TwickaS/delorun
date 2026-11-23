// @vitest-environment jsdom
/**
 * The consent surfaces of the studio: the full-access consent that upstream's permission control asks before a chat
 * switches to full access in a workspace without a grant, the approval card's full-access action, the MCP server review,
 * the notice that a server waits, the approval card's external-agent action, and the Permissions and External agents sections with their revokes. The denial cases prove that a remote
 * studio, an unanswered consent and a stale review record nothing, that a phone sees "Approve this at your computer"
 * instead of a button, and that a profile without the consent plugins (such as one set up with "Ask less (like DeepSeek Harness)") keeps
 * upstream's behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { MCP_ASK_MODES, MCP_CONSENT_ROUTES, type ServerOrigin } from '@delorun/plugin-mcp-consent/wire'
import { PERMISSION_ROUTES } from '@delorun/plugin-permission-defaults/wire'
import { DELEGATION_CONSENT_ROUTES, type DelegationConsentSettings, type GrantView, type LevelsAnswer } from '@delorun/plugin-delegation-consent/wire'
import { en, zh } from '../src/client/consents-locales.ts'
import { HostRequestError, type HostFetch } from '../src/client/host-api.ts'
import { readServers, type McpConsentSettings, type WorkspaceAccess } from '../src/client/consents-api.ts'
import {
  confirmPermissionSwitch, consentFailureText, ownsPermissionConfirmation, createFullAccessConsentSource, FullAccessConsent, FULL_ACCESS_COMMAND,
  workspaceName, type FullAccessConsentProps, type FullAccessConsentSource, type SwitchAnswer,
} from '../src/client/FullAccessConsent.tsx'
import { AllowForChat, ChatSwitchRefused, type AllowForChatProps } from '../src/client/AllowForChat.tsx'
import { FullAccessAction, type FullAccessActionProps } from '../src/client/FullAccessAction.tsx'
import { agentOfferFor, ExternalAgentAction, type ExternalAgentActionProps } from '../src/client/ExternalAgentAction.tsx'
import { createMcpReviewSource, McpServerReview, serverChangeText, type McpReviewSource, type McpServerReviewProps } from '../src/client/McpServerReview.tsx'
import { createMcpStartCardMemory, McpStartCard, originText, type McpStartCardProps } from '../src/client/McpStartCard.tsx'
import { McpAskWriter } from '../src/client/mcp-ask-writer.ts'
import { levelChipText } from '../src/client/AgentLevels.tsx'
import { AGENTS_COMMAND, ExternalAgentsSection, type ExternalAgentsSectionProps } from '../src/client/ExternalAgentsSection.tsx'
import { MCP_COMMAND, PermissionsSection, type PermissionsSectionProps } from '../src/client/PermissionsSection.tsx'
import { OptIn } from '../src/client/opt-in.ts'
import { switchChat } from '../src/client/index.ts'

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
    const askSwitch = vi.fn(async (): Promise<SwitchAnswer> => 'submit')
    await expect(confirmPermissionSwitch(host.fetch, { ask, askSwitch }, 'chat-1', 'workspace-write')).resolves.toBe('submit')
    expect(host.received).toEqual([])
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks the short form when the profile has no per-workspace consent, the workspace holds a grant, or the chat has no folder', async () => {
    const unmounted = fakeHost()
    const granted = fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: { status: 200, body: { access: ON } } })
    const nowhere = fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: refusal(422, 'NO_WORKSPACE') })
    // A chat with no folder names no chat for the home to switch; the other two name it, though only a missing grant switches it.
    for (const [host, args] of [[unmounted, [undefined, undefined, 'chat-1']], [granted, [ON, undefined, 'chat-1']], [nowhere, [undefined]]] as const) {
      const askSwitch = vi.fn(async (): Promise<SwitchAnswer> => 'submit')
      await expect(confirmPermissionSwitch(host.fetch, { ask: vi.fn(), askSwitch }, 'chat-1', 'danger-full-access')).resolves.toBe('submit')
      expect(askSwitch.mock.calls).toEqual([args])
    }
  })

  it('shows the grant form for a workspace without a grant, and submits only what the person confirms', async () => {
    const host = fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: { status: 200, body: { access: OFF } } })
    for (const answer of ['switched', 'submit', 'cancelled'] as const) {
      const askSwitch = vi.fn(async (): Promise<SwitchAnswer> => answer)
      await expect(confirmPermissionSwitch(host.fetch, { ask: vi.fn(), askSwitch }, 'chat-1', 'danger-full-access')).resolves.toBe(answer)
      expect(askSwitch).toHaveBeenCalledWith(OFF, undefined, 'chat-1')
    }
    expect(host.received.find(entry => entry.key === `POST ${PERMISSION_ROUTES.review}`)?.body).toEqual({ sessionId: 'chat-1' })
  })

  it('shows a remote studio the consent without a way to grant, and submits nothing', async () => {
    const host = fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: REMOTE })
    const ask = vi.fn(async () => false)
    await expect(confirmPermissionSwitch(host.fetch, { ask, askSwitch: vi.fn() }, 'chat-1', 'danger-full-access')).resolves.toBe('cancelled')
    expect(ask).toHaveBeenCalledWith(undefined)
  })

  it('submits nothing when the home cannot answer the review', async () => {
    const host = fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: refusal(500, 'STORE_REFUSED') })
    await expect(confirmPermissionSwitch(host.fetch, { ask: vi.fn(), askSwitch: vi.fn() }, 'chat-1', 'danger-full-access')).rejects.toThrow('STORE_REFUSED')
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

  it('claims the question for full access only', () => {
    expect([ownsPermissionConfirmation('danger-full-access'), ownsPermissionConfirmation('workspace-write'), ownsPermissionConfirmation('auto')]).toEqual([true, false, false])
  })

  it('asks the composer\'s switch with an acknowledgement that gates the button, and records the grant before it answers', async () => {
    const host = fakeHost({ [`POST ${PERMISSION_ROUTES.setFullAccess}`]: { status: 200, body: { access: ON, chats: 0 } } })
    const source = createFullAccessConsentSource(host.fetch)
    const answered = source.askSwitch(OFF)
    renderConsent(source)
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: en['consent.confirm'] })
    expect(confirm.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: en['consent.acknowledge'] }))
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await expect(answered).resolves.toBe('submit')
    expect(host.received).toEqual([{ key: `POST ${PERMISSION_ROUTES.setFullAccess}`, body: { workspace: OFF.workspace, reviewId: OFF.reviewId, on: true, confirmed: true } }])
  })

  it('records the grant and switches the chat in one call, and then leaves the composer nothing to submit', async () => {
    // Submitting the switch again sent `/permission` through commands/execute, which a device confirmed a second time (F-2).
    const host = fakeHost({ [`POST ${PERMISSION_ROUTES.setFullAccess}`]: { status: 200, body: { access: ON, chats: 1 } } })
    const source = createFullAccessConsentSource(host.fetch)
    const answered = confirmPermissionSwitch(fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: { status: 200, body: { access: OFF } } }).fetch, source, 'chat-1', 'danger-full-access')
    await waitFor(() => { expect(source.hooks.consent.getSnapshot()).not.toBeNull() })
    renderConsent(source)
    fireEvent.click(screen.getByRole('checkbox', { name: en['consent.acknowledge'] }))
    fireEvent.click(screen.getByRole('button', { name: en['consent.confirm'] }))
    await expect(answered).resolves.toBe('switched')
    expect(host.received).toEqual([{ key: `POST ${PERMISSION_ROUTES.setFullAccess}`, body: { workspace: OFF.workspace, reviewId: OFF.reviewId, on: true, confirmed: true, chat: 'chat-1' } }])
  })

  it('answers no and records nothing when the asker no longer wants the switch at the confirm', async () => {
    for (const access of [OFF, ON]) {
      const host = fakeHost()
      const source = createFullAccessConsentSource(host.fetch)
      const answered = source.askSwitch(access, () => false)
      renderConsent(source)
      fireEvent.click(screen.getByRole('checkbox'))
      fireEvent.click(screen.getByRole('button', { name: access === OFF ? en['consent.confirm'] : en['switch.confirm'] }))
      await expect(answered).resolves.toBe('cancelled')
      expect(host.received).toEqual([])
      cleanup()
    }
  })

  it('hands the asker\'s wish to the consent it opens', async () => {
    const wanted = () => true
    const askSwitch = vi.fn(async (): Promise<SwitchAnswer> => 'submit')
    await confirmPermissionSwitch(fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: { status: 200, body: { access: OFF } } }).fetch, { ask: vi.fn(), askSwitch }, 'chat-1', 'danger-full-access', wanted)
    await confirmPermissionSwitch(fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: refusal(422, 'NO_WORKSPACE') }).fetch, { ask: vi.fn(), askSwitch }, 'chat-1', 'danger-full-access', wanted)
    expect(askSwitch.mock.calls).toEqual([[OFF, wanted, 'chat-1'], [undefined, wanted]])
  })

  it('asks the short form without recording anything, and answers no when cancelled', async () => {
    const host = fakeHost()
    const source = createFullAccessConsentSource(host.fetch)
    const confirmed = source.askSwitch(ON)
    renderConsent(source)
    expect(screen.getByRole('dialog', { name: en['switch.title'] })).toBeTruthy()
    expect(screen.getByText(en['switch.risk'])).toBeTruthy()
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: en['switch.confirm'] })
    expect(confirm.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(confirm)
    await expect(confirmed).resolves.toBe('submit')
    const cancelled = source.askSwitch(undefined)
    source.cancel()
    await expect(cancelled).resolves.toBe('cancelled')
    expect(host.received).toEqual([])
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
    const busy = open({ seq: 1, form: 'grant', access: OFF, acknowledge: false, busy: true })
    fireEvent.click(screen.getByRole('button', { name: en['consent.close'] }))
    expect(cancel).not.toHaveBeenCalled()
    busy.unmount()
    open({ seq: 2, form: 'grant', access: OFF, acknowledge: false, busy: false })
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
  serverName: 'files', reviewId: 'd'.repeat(32), origin: { kind: 'plugin', plugin: '@acme/tools' } as ServerOrigin, command: 'npx', args: ['-y', 'server-filesystem'], cwd: '',
  resolvedCommand: '/usr/local/bin/npx', resolvedCwd: '/home/person',
  env: [{ name: 'API_TOKEN' }, { name: 'NODE_OPTIONS', value: '--require ./hook.js' }], files: [] as { argument?: number, path: string, sha256: string }[],
  writableByChats: [] as string[], changedVariables: [] as string[], state: 'waiting' as const,
  reason: 'the acceptance store holds no acceptance for this command', change: 'new' as const, reviewedAt: NOW - 60_000,
}
const ACCEPTED = {
  acceptanceId: 'e'.repeat(32), serverName: 'git', command: 'uvx', args: ['mcp-server-git'], cwd: '/srv/git',
  resolvedCommand: '/opt/uv/uvx.cmd', resolvedCwd: '/srv/git', resolvedShell: '/Windows/System32/cmd.exe', env: [], files: [], acceptedAt: NOW - 86_400_000, configured: true,
}
const SERVERS = (servers: readonly object[], accepted: readonly object[] = []): Answer => ({ status: 200, body: { servers, accepted } })

/**
 * The approval card's owner props and the line's face, over a fake home.
 * @param host - the fake home.
 * @param overrides - the props a case changes.
 * @returns the props.
 */
function actionProps(host: ReturnType<typeof fakeHost>, overrides: Partial<FullAccessActionProps> = {}): FullAccessActionProps {
  return {
    t: makeTranslate(en), grants: 'full-access', toolName: 'bash', callId: undefined, allow: vi.fn(async () => {}),
    answered: false, canAnswer: () => true, sessionId: 'chat-1', fetch: host.fetch, openLevels: vi.fn(), ...overrides,
  } as FullAccessActionProps
}

describe('the approval card\'s full-access line', () => {
  it('tells a phone to approve at the computer, with no button, also on the consent\'s own card', async () => {
    for (const toolName of ['bash', 'permission']) {
      const props = actionProps(fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: REMOTE }), { toolName })
      const { unmount } = render(<FullAccessAction {...props} />)
      await settle()
      expect(screen.getByRole('status').textContent).toBe(en['action.atComputer'])
      expect(screen.queryByRole('button')).toBeNull()
      unmount()
    }
  })

  it('shows nothing at the home\'s computer, for another grant, a chat without a folder and a profile without the plugin', async () => {
    const reviewed = fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: { status: 200, body: { access: OFF } } })
    const cases = [
      actionProps(reviewed),
      actionProps(reviewed, { grants: 'workspace-management' }),
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

  it('shows nothing when the card goes away before the home answers its review', async () => {
    const { container, unmount } = render(<FullAccessAction {...actionProps(fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: REMOTE }))} />)
    unmount()
    await settle()
    expect(container.innerHTML).toBe('')
  })
})

/**
 * The approval card's owner props and the choice's face, over a fake home.
 * @param host - the fake home.
 * @param overrides - the props a case changes.
 * @returns the props.
 */
function choiceProps(host: ReturnType<typeof fakeHost>, overrides: Partial<AllowForChatProps> = {}): AllowForChatProps {
  return {
    t: makeTranslate(en), escalatesTo: 'danger-full-access', toolName: 'bash', callId: undefined, allow: vi.fn(async () => {}), offer: vi.fn(),
    answered: false, canAnswer: () => true, sessionId: 'chat-1', fetch: host.fetch,
    consent: { ask: vi.fn(async () => true), askSwitch: vi.fn(async (): Promise<SwitchAnswer> => 'submit') },
    currentPreset: () => 'read-only', switchTo: vi.fn(async () => {}), ...overrides,
  } as AllowForChatProps
}

const REVIEWED_OFF = { [`POST ${PERMISSION_ROUTES.review}`]: { status: 200, body: { access: OFF } } }
const allowForChat = () => screen.getByRole<HTMLButtonElement>('button', { name: en['action.allowForChat'] })

describe('the approval card\'s "Allow for this chat" choice', () => {
  it('switches a workspace-write request at once, without a dialog, then answers the card', async () => {
    const props = choiceProps(fakeHost(), { escalatesTo: 'workspace-write' })
    render(<AllowForChat {...props} />)
    expect(props.offer).toHaveBeenLastCalledWith(true)
    fireEvent.click(allowForChat())
    await settle()
    expect(props.switchTo).toHaveBeenCalledWith('workspace-write')
    expect(props.consent.askSwitch).not.toHaveBeenCalled()
    expect(props.allow).toHaveBeenCalledTimes(1)
  })

  it('asks the one dialog for a full-access request, then switches and answers the card', async () => {
    const host = fakeHost(REVIEWED_OFF)
    const props = choiceProps(host)
    render(<AllowForChat {...props} />)
    await settle()
    fireEvent.click(allowForChat())
    await settle()
    expect(props.consent.askSwitch).toHaveBeenCalledWith(OFF, props.canAnswer, 'chat-1')
    expect(props.switchTo).toHaveBeenCalledWith('danger-full-access')
    expect(props.allow).toHaveBeenCalledTimes(1)
  })

  it('answers the card without a second switch when the grant already switched the chat', async () => {
    // A second switch goes through commands/execute, which a device confirms again (F-2).
    const props = choiceProps(fakeHost(REVIEWED_OFF), { consent: { ask: vi.fn(), askSwitch: vi.fn(async (): Promise<SwitchAnswer> => 'switched') } })
    render(<AllowForChat {...props} />)
    await settle()
    fireEvent.click(allowForChat())
    await settle()
    expect(props.switchTo).not.toHaveBeenCalled()
    expect(props.allow).toHaveBeenCalledTimes(1)
  })

  it('leaves the card waiting when the person cancels the dialog', async () => {
    const props = choiceProps(fakeHost(REVIEWED_OFF), { consent: { ask: vi.fn(), askSwitch: vi.fn(async (): Promise<SwitchAnswer> => 'cancelled') } })
    render(<AllowForChat {...props} />)
    await settle()
    fireEvent.click(allowForChat())
    await settle()
    expect(props.switchTo).not.toHaveBeenCalled()
    expect(props.allow).not.toHaveBeenCalled()
    expect(allowForChat().disabled).toBe(false)
  })

  it('is not offered to a chat already at or above the requested mode', async () => {
    const cases: [AllowForChatProps['escalatesTo'], string][] = [['workspace-write', 'workspace-write'], ['workspace-write', 'danger-full-access'], ['danger-full-access', 'danger-full-access']]
    for (const [escalatesTo, current] of cases) {
      const props = choiceProps(fakeHost(REVIEWED_OFF), { escalatesTo, currentPreset: () => current })
      const { container, unmount } = render(<AllowForChat {...props} />)
      await settle()
      expect(container.innerHTML).toBe('')
      expect(props.offer).toHaveBeenLastCalledWith(false)
      unmount()
    }
  })

  it('is offered full access from workspace-write, and workspace-write from a preset that is neither', async () => {
    const full = choiceProps(fakeHost(REVIEWED_OFF), { currentPreset: () => 'workspace-write' })
    const { unmount } = render(<AllowForChat {...full} />)
    await settle()
    expect(allowForChat()).toBeTruthy()
    unmount()
    render(<AllowForChat {...choiceProps(fakeHost(), { escalatesTo: 'workspace-write', currentPreset: () => undefined })} />)
    expect(allowForChat()).toBeTruthy()
  })

  it('shows no button for a full-access request on a remote studio', async () => {
    const props = choiceProps(fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: REMOTE }))
    const { container } = render(<AllowForChat {...props} />)
    await settle()
    expect(container.innerHTML).toBe('')
    expect(props.offer).not.toHaveBeenCalledWith(true)
  })

  it('offers a full-access request in a chat without a folder, which asks the short form', async () => {
    const props = choiceProps(fakeHost({ [`POST ${PERMISSION_ROUTES.review}`]: refusal(422, 'NO_WORKSPACE') }))
    render(<AllowForChat {...props} />)
    await settle()
    fireEvent.click(allowForChat())
    await settle()
    expect(props.consent.askSwitch).toHaveBeenCalledWith(undefined, props.canAnswer)
    expect(props.allow).toHaveBeenCalledTimes(1)
  })

  it('is disabled once the card answered or no longer accepts an answer, so a click does nothing', async () => {
    for (const overrides of [{ answered: true }, { canAnswer: () => false }]) {
      const props = choiceProps(fakeHost(), { escalatesTo: 'workspace-write', ...overrides })
      const { unmount } = render(<AllowForChat {...props} />)
      expect(allowForChat().disabled).toBe(true)
      fireEvent.click(allowForChat())
      await settle()
      expect(props.switchTo).not.toHaveBeenCalled()
      expect(props.allow).not.toHaveBeenCalled()
      unmount()
    }
  })

  it('does nothing when the card no longer accepts an answer at the click', async () => {
    let answerable = true
    const props = choiceProps(fakeHost(), { escalatesTo: 'workspace-write', canAnswer: () => answerable })
    render(<AllowForChat {...props} />)
    answerable = false
    fireEvent.click(allowForChat())
    await settle()
    expect(props.switchTo).not.toHaveBeenCalled()
    expect(props.allow).not.toHaveBeenCalled()
  })

  it('does not switch a chat when the card stopped accepting an answer while the dialog was open', async () => {
    let answerable = true
    const askSwitch = vi.fn(async (): Promise<SwitchAnswer> => { answerable = false; return 'submit' })
    const props = choiceProps(fakeHost(REVIEWED_OFF), { canAnswer: () => answerable, consent: { ask: vi.fn(), askSwitch } })
    render(<AllowForChat {...props} />)
    await settle()
    fireEvent.click(allowForChat())
    await settle()
    expect(props.switchTo).not.toHaveBeenCalled()
    expect(props.allow).not.toHaveBeenCalled()
  })

  it('ignores a second click while the switch is under way and answers the card once', async () => {
    let finish!: () => void
    const switchTo = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const props = choiceProps(fakeHost(), { escalatesTo: 'workspace-write', switchTo })
    render(<AllowForChat {...props} />)
    fireEvent.click(allowForChat())
    await settle()
    expect(allowForChat().disabled).toBe(true)
    fireEvent.click(allowForChat())
    await settle()
    finish()
    await settle()
    expect(switchTo).toHaveBeenCalledTimes(1)
    expect(props.allow).toHaveBeenCalledTimes(1)
  })

  it('keeps the switched preset and does not answer a card that stopped accepting an answer during the switch', async () => {
    let answerable = true
    const switchTo = vi.fn(async () => { answerable = false })
    const props = choiceProps(fakeHost(), { escalatesTo: 'workspace-write', switchTo, canAnswer: () => answerable })
    render(<AllowForChat {...props} />)
    fireEvent.click(allowForChat())
    await settle()
    expect(switchTo).toHaveBeenCalledTimes(1)
    expect(props.allow).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the home\'s sentence under the button when the switch is refused, and leaves the card unanswered', async () => {
    const props = choiceProps(fakeHost(), {
      escalatesTo: 'workspace-write',
      switchTo: vi.fn(async () => { throw new ChatSwitchRefused('Only the home\'s computer can change this.') }),
    })
    render(<AllowForChat {...props} />)
    fireEvent.click(allowForChat())
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('Only the home\'s computer can change this.')
    expect(props.allow).not.toHaveBeenCalled()
    expect(allowForChat().disabled).toBe(false)
  })

  it('words a home failure while the dialog records the grant', async () => {
    const props = choiceProps(fakeHost(REVIEWED_OFF), { consent: { ask: vi.fn(), askSwitch: vi.fn(async () => { throw new HostRequestError('/review', { kind: 'refused', status: 409, code: 'STALE_REVIEW', message: 'stale' }) }) } })
    render(<AllowForChat {...props} />)
    await settle()
    fireEvent.click(allowForChat())
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(en['failed.stale'])
    expect(props.allow).not.toHaveBeenCalled()
  })

  it('answers a request the chat reaches once it was raised after the card rendered, with no switch', async () => {
    let current = 'read-only'
    const props = choiceProps(fakeHost(), { escalatesTo: 'workspace-write', currentPreset: () => current })
    render(<AllowForChat {...props} />)
    current = 'danger-full-access'
    fireEvent.click(allowForChat())
    await settle()
    expect(props.switchTo).not.toHaveBeenCalled()
    expect(props.allow).toHaveBeenCalledTimes(1)
  })

  it('shows no dialog for a full-access request once the chat was raised to full access after the card rendered', async () => {
    let current = 'workspace-write'
    const props = choiceProps(fakeHost(REVIEWED_OFF), { currentPreset: () => current })
    render(<AllowForChat {...props} />)
    await settle()
    current = 'danger-full-access'
    fireEvent.click(allowForChat())
    await settle()
    expect(props.consent.askSwitch).not.toHaveBeenCalled()
    expect(props.switchTo).not.toHaveBeenCalled()
    expect(props.allow).toHaveBeenCalledTimes(1)
  })

  it('resolves the switch once the chat\'s permission reports the requested preset', async () => {
    let current = 'read-only'
    const live = { command: vi.fn(async (_line: string) => { current = 'workspace-write'; return { ok: true as const, value: { matched: true } } }) }
    await expect(switchChat(live, () => current, 'workspace-write')).resolves.toBeUndefined()
    expect(live.command).toHaveBeenCalledWith('/permission workspace-write')
  })

  it('leaves the card unanswered with a failure when the command matches but the chat\'s permission keeps its preset', async () => {
    const live = { command: vi.fn(async (_line: string) => ({ ok: true as const, value: { matched: true } })) }
    const props = choiceProps(fakeHost(), { escalatesTo: 'workspace-write', switchTo: preset => switchChat(live, () => 'read-only', preset) })
    render(<AllowForChat {...props} />)
    fireEvent.click(allowForChat())
    await settle()
    expect(live.command).toHaveBeenCalledWith('/permission workspace-write')
    expect(props.allow).not.toHaveBeenCalled()
    expect(allowForChat().disabled).toBe(false)
    expect(screen.getByRole('alert').textContent).toContain('did not change')
  })

  it('reports no shown button once it unmounts', async () => {
    const props = choiceProps(fakeHost(), { escalatesTo: 'workspace-write' })
    const { unmount } = render(<AllowForChat {...props} />)
    unmount()
    expect(props.offer).toHaveBeenLastCalledWith(false)
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
      expect(host.received.map(request => request.key)).toEqual([`GET ${DELEGATION_CONSENT_ROUTES.grants}`, `GET ${DELEGATION_CONSENT_ROUTES.levels}`])
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
    expect(host.received.map(request => request.key)).toEqual([`GET ${DELEGATION_CONSENT_ROUTES.grants}`, `GET ${DELEGATION_CONSENT_ROUTES.levels}`])
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
    expect(host.received.map(request => request.key)).toEqual([`GET ${DELEGATION_CONSENT_ROUTES.grants}`, `GET ${DELEGATION_CONSENT_ROUTES.levels}`, `POST ${DELEGATION_CONSENT_ROUTES.allow}`])
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

  it('says a file it runs changed, and lists the files it runs under Details', () => {
    const source = createMcpReviewSource(fakeHost().fetch)
    const files = [{ path: '/opt/node/bin/node', sha256: `sha256:${'a'.repeat(64)}` }, { argument: 0, path: '/work/server.js', sha256: `sha256:${'b'.repeat(64)}` }]
    void source.ask({ ...SERVER, change: 'contents', files })
    renderReview(source)
    const dialog = screen.getByRole('dialog', { name: 'Allow files to start?' })
    expect(within(dialog).getByText(en['mcp.change.contents'])).toBeTruthy()
    expect(within(dialog).getByText(en['mcp.files'])).toBeTruthy()
    expect(within(dialog).getByText((_content, element) => element?.tagName === 'CODE' && element.textContent === '/opt/node/bin/node\n/work/server.js')).toBeTruthy()
  })

  it('names the file the command links to, which is the file that starts, and the paths chats can write', () => {
    const source = createMcpReviewSource(fakeHost().fetch)
    const files = [{ path: '/usr/local/lib/npx-cli.js', sha256: `sha256:${'a'.repeat(64)}` }, { argument: 1, path: '/work/server.js', sha256: `sha256:${'b'.repeat(64)}` }]
    void source.ask({ ...SERVER, files, writableByChats: ['/work', '/work/server.js'] })
    renderReview(source)
    const dialog = screen.getByRole('dialog', { name: 'Allow files to start?' })
    expect(within(dialog).getByText('/usr/local/bin/npx links to /usr/local/lib/npx-cli.js, which is the file Delorun starts.')).toBeTruthy()
    expect(within(dialog).getByText('Chats can write to /work, /work/server.js, so a chat can change what this server runs.')).toBeTruthy()
  })

  it('says nothing about a link or about what chats can write when the command is the file itself and none is writable', () => {
    const source = createMcpReviewSource(fakeHost().fetch)
    void source.ask({ ...SERVER, files: [{ path: '/usr/local/bin/npx', sha256: `sha256:${'a'.repeat(64)}` }] })
    renderReview(source)
    const dialog = screen.getByRole('dialog', { name: 'Allow files to start?' })
    expect(dialog.querySelector('[data-links]')).toBeNull()
    expect(dialog.querySelector('[data-writable]')).toBeNull()
  })

  it('reads the pinned files of each waiting server, and refuses an answer whose file names an argument by no index', async () => {
    const files = [{ path: '/opt/node/bin/node', sha256: `sha256:${'a'.repeat(64)}` }, { argument: 0, path: '/work/server.js', sha256: `sha256:${'b'.repeat(64)}` }]
    const good = fakeHost({ [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([{ ...SERVER, files }]) })
    await expect(readServers(good.fetch)).resolves.toMatchObject({ servers: [{ files }] })
    const bad = fakeHost({ [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([{ ...SERVER, files: [files[0], { ...files[1], argument: -1 }] }]) })
    await expect(readServers(bad.fetch)).rejects.toThrow()
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

  it('shows a templated argument unresolved with a note that it is filled from stored credentials at start', () => {
    const source = createMcpReviewSource(fakeHost().fetch)
    void source.ask({ ...SERVER, args: ['--token=${credential:MCP_TOKEN}'] })
    renderReview(source)
    const details = screen.getByText(en['mcp.details']).closest('details')
    if (details === null) throw new Error('no details')
    expect(within(details).getByText('"--token=${credential:MCP_TOKEN}"')).toBeTruthy()
    expect(within(details).getByText(en['mcp.argsTemplated'])).toBeTruthy()
  })

  it('adds no credential note to a start without templates', () => {
    const source = createMcpReviewSource(fakeHost().fetch)
    void source.ask(SERVER)
    renderReview(source)
    expect(screen.queryByText(en['mcp.argsTemplated'])).toBeNull()
  })

  it('says what changed since the person allowed the server', () => {
    const source = createMcpReviewSource(fakeHost().fetch)
    void source.ask({ ...SERVER, change: 'environment', changedVariables: ['NODE_OPTIONS', 'PATH'] })
    renderReview(source)
    expect(screen.getByText('Its environment variables changed since you allowed it: NODE_OPTIONS, PATH.')).toBeTruthy()
  })

  it('says in its own words what each review asks about', () => {
    const t = makeTranslate(en)
    for (const change of ['new', 'command', 'arguments', 'directory', 'resolved', 'contents', 'unreadable'] as const) {
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
 * Render the MCP start card over a fake home.
 * @param host - the fake home.
 * @param faces - the review's question and the memory of set-aside cards.
 * @returns the render result, the toast spy and the memory.
 */
function renderCard(host: ReturnType<typeof fakeHost>, review: McpReviewSource['ask'] = async () => undefined, memory = createMcpStartCardMemory()) {
  const notify = vi.fn<McpStartCardProps['notify']>()
  const props = { t: makeTranslate(en), fetch: host.fetch, review, notify, useHidden: bindSnapshotSelector(memory.hooks.hidden), hide: memory.hide } as McpStartCardProps
  return { notify, memory, ...render(<McpStartCard {...props} />) }
}

const cardButton = (name: string): HTMLElement => screen.getByRole('button', { name })
const acceptsOf = (host: ReturnType<typeof fakeHost>) => host.received.filter(request => request.key === `POST ${MCP_CONSENT_ROUTES.accept}`)

describe('the card that says an MCP server wants to start', () => {
  const ORIGINS: readonly (readonly [ServerOrigin, string])[] = [
    [{ kind: 'plugin', plugin: '@acme/tools' }, 'From plugin @acme/tools'],
    [{ kind: 'chat' }, 'From your editor'],
    [{ kind: 'unknown' }, 'From a place Delorun could not identify'],
    [{ kind: 'profile' }, 'From your own settings'],
    [{ kind: 'settings' }, 'From your MCP servers in Settings'],
    [{ kind: 'pack', pack: 'Media', plugin: '@delorun/plugin-media' }, 'From Delorun\'s Media pack'],
  ]

  it('names the server and, in one muted line, where it comes from, for every kind of origin', async () => {
    for (const [origin, line] of ORIGINS) {
      const { unmount } = renderCard(fakeHost({ [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([{ ...SERVER, origin }]) }))
      await settle()
      const card = screen.getByRole('status')
      expect(within(card).getByText('files wants to start')).toBeTruthy()
      expect(within(card).getByText(line)).toBeTruthy()
      expect(originText(makeTranslate(en), origin)).toBe(line)
      // A content-width glass card, never the notice's full-width banner.
      expect(card.className).toContain('delorun-glass')
      expect(within(card).getByText('files wants to start').className).toContain('delorun-alert-title')
      expect(within(card).getByText(line).className).toContain('delorun-alert-line')
      expect(cardButton(en['mcp.card.allow']).className).toContain('delorun-alert-primary')
      expect(cardButton(en['mcp.card.later']).className).toContain('delorun-alert-secondary')
      unmount()
    }
  })

  it('has the zh copy for every origin line', () => {
    const t = makeTranslate(zh)
    for (const [origin] of ORIGINS) expect(originText(t, origin)).not.toContain('mcp.card')
  })

  it('sends exactly one accept for the review when Allow is pressed, and says the server started', async () => {
    const host = fakeHost({
      [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([SERVER]),
      [`POST ${MCP_CONSENT_ROUTES.accept}`]: { status: 200, body: { started: 1 } },
    })
    const { notify } = renderCard(host)
    await settle()
    fireEvent.click(cardButton(en['mcp.card.allow']))
    fireEvent.click(cardButton(en['mcp.card.allow']))
    await settle()
    expect(acceptsOf(host).map(request => request.body)).toEqual([{ serverName: 'files', reviewId: SERVER.reviewId, confirmed: true }])
    expect(notify).toHaveBeenCalledWith('files started. Chats can use its tools from your next message.', false)
  })

  it('says the server starts the next time a chat uses it when no stopped row started', async () => {
    const host = fakeHost({
      [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([SERVER]),
      [`POST ${MCP_CONSENT_ROUTES.accept}`]: { status: 200, body: { started: 0 } },
    })
    const { notify } = renderCard(host)
    await settle()
    fireEvent.click(cardButton(en['mcp.card.allow']))
    await settle()
    expect(notify).toHaveBeenCalledWith('files is allowed. It starts the next time a chat uses it.', false)
  })

  it('shows the existing error text, as a failure, when the accept is refused', async () => {
    const host = fakeHost({
      [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([SERVER]),
      [`POST ${MCP_CONSENT_ROUTES.accept}`]: refusal(409, 'STALE_REVIEW'),
    })
    const { notify } = renderCard(host)
    await settle()
    fireEvent.click(cardButton(en['mcp.card.allow']))
    await settle()
    expect(notify).toHaveBeenCalledWith(en['failed.stale'], true)
  })

  it('hides the card for that review on Not now, sends nothing, and shows it again for a new review', async () => {
    const host = fakeHost({ [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([SERVER]) })
    const { container, memory } = renderCard(host)
    await settle()
    fireEvent.click(cardButton(en['mcp.card.later']))
    await settle()
    expect(container.innerHTML).toBe('')
    expect(host.received.filter(request => request.key.startsWith('POST'))).toEqual([])
    // Another card of the same studio session, such as another chat's, stays hidden too.
    const other = renderCard(host, undefined, memory)
    await settle()
    expect(other.container.innerHTML).toBe('')
    other.unmount()
    // A new review of the server's start has a new id, which shows the card again.
    host.script[`GET ${MCP_CONSENT_ROUTES.pending}`] = SERVERS([{ ...SERVER, reviewId: '9'.repeat(32) }])
    const again = renderCard(host, undefined, memory)
    await settle()
    expect(within(again.container).getByText('files wants to start')).toBeTruthy()
  })

  it('opens the full review from Details, says the outcome of an answer given there, and reads the list again', async () => {
    const review = vi.fn(async () => 1)
    const host = fakeHost({ [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([SERVER]) })
    const { notify } = renderCard(host, review)
    await settle()
    fireEvent.click(cardButton(en['mcp.card.details']))
    await settle()
    expect(review).toHaveBeenCalledWith(SERVER)
    expect(acceptsOf(host)).toEqual([])
    expect(notify).toHaveBeenCalledWith('files started. Chats can use its tools from your next message.', false)
    expect(host.received.filter(request => request.key === `GET ${MCP_CONSENT_ROUTES.pending}`).length).toBeGreaterThan(1)
  })

  it('names the first of several waiting servers with its place, and none that the person declined or revoked', async () => {
    const other = { ...SERVER, serverName: 'git', reviewId: 'f'.repeat(32) }
    renderCard(fakeHost({ [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([SERVER, other, { ...SERVER, serverName: 'old', state: 'declined' }]) }))
    await settle()
    expect(screen.getByText('files wants to start')).toBeTruthy()
    expect(screen.getByText(/1 of 2/)).toBeTruthy()
    expect(screen.queryByText('old wants to start')).toBeNull()
  })

  it('shows no place count for one waiting server', async () => {
    renderCard(fakeHost({ [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([SERVER]) }))
    await settle()
    expect(screen.queryByText(/1 of/)).toBeNull()
  })

  it('tells a remote studio, which reads only the names, to allow at the computer, with no Allow or Details', async () => {
    const host = fakeHost({ [`GET ${MCP_CONSENT_ROUTES.pending}`]: REMOTE, [`GET ${MCP_CONSENT_ROUTES.waiting}`]: { status: 200, body: { servers: [{ serverName: 'files', change: 'new' }] } } })
    renderCard(host)
    await settle()
    expect(screen.getByText('files wants to start')).toBeTruthy()
    expect(screen.getByText(en['mcp.card.remote'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: en['mcp.card.allow'] })).toBeNull()
    expect(screen.queryByRole('button', { name: en['mcp.card.details'] })).toBeNull()
    fireEvent.click(cardButton(en['mcp.card.later']))
    await settle()
    expect(screen.queryByText('files wants to start')).toBeNull()
    expect(acceptsOf(host)).toEqual([])
  })

  it('never takes focus, and its buttons are reachable by keyboard', async () => {
    const before = document.createElement('button')
    document.body.append(before)
    before.focus()
    renderCard(fakeHost({ [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([SERVER]) }))
    await settle()
    expect(document.activeElement).toBe(before)
    for (const name of [en['mcp.card.allow'], en['mcp.card.later'], en['mcp.card.details']]) {
      const button = cardButton(name)
      expect(button.tabIndex).toBeGreaterThanOrEqual(0)
      expect(button.getAttribute('tabindex')).toBeNull()
    }
    before.remove()
  })

  it('shows nothing while no server waits, and in a profile without the plugin', async () => {
    for (const host of [fakeHost({ [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([]) }), fakeHost()]) {
      const { container, unmount } = renderCard(host)
      await settle()
      expect(container.innerHTML).toBe('')
      unmount()
    }
  })
})

/**
 * The external-agent consent row's Host settings form, accepting each write as the Host would.
 * @param value - the row's fields, or undefined for a profile that does not serve the row.
 * @returns the form, its recorded writes and the writer the section uses.
 */
function agentSettingsForm(value?: DelegationConsentSettings) {
  const state = createSnapshotStore<ConfigFormSnapshot<DelegationConsentSettings>>({
    status: value === undefined ? 'unavailable' : 'ready', value, base: {}, user: {}, revision: 0, writable: true,
  })
  const set = vi.fn(async (field: string, next: unknown) => {
    state.update((draft) => { if (draft.value !== undefined) draft.value = { ...draft.value, [field]: next } })
    return true
  })
  const form: ConfigForm<DelegationConsentSettings> = {
    getSnapshot: () => state.getSnapshot(), subscribe: listener => state.subscribe(listener), set, unset: vi.fn(), mutate: vi.fn(),
  }
  return { form, set, writer: new OptIn(form) }
}

/**
 * The MCP consent row's Host settings form, answering each mutation as the Host would.
 * @param value - the row's fields, or undefined for a profile that does not serve the row.
 * @param accepts - whether the Host accepts a write; a reach device is refused it.
 * @returns the form, its mutation and the writer the section uses.
 */
function mcpConsentForm(value?: McpConsentSettings, accepts = true) {
  const state = createSnapshotStore<ConfigFormSnapshot<McpConsentSettings>>({
    status: value === undefined ? 'unavailable' : 'ready', value, base: {}, user: {}, revision: 0, writable: true,
  })
  const mutate = vi.fn(async (ops: readonly { op: string; path: readonly string[]; value?: unknown }[]) => {
    const chosen = MCP_ASK_MODES.find(mode => ops.some(op => op.path[0] === 'ask' && op.value === mode))
    if (accepts && chosen !== undefined) state.update((draft) => { if (draft.value !== undefined) draft.value = { ...draft.value, ask: chosen } })
    return accepts
  })
  const form: ConfigForm<McpConsentSettings> = {
    getSnapshot: () => state.getSnapshot(), subscribe: listener => state.subscribe(listener), set: vi.fn(), unset: vi.fn(), mutate,
  }
  return { form, mutate, writer: new McpAskWriter(form) }
}

/**
 * Render the Permissions section over a fake home.
 * @param host - the fake home.
 * @param faces - the consent's and the review's questions, and the MCP consent row's form.
 * @returns the render result.
 */
function renderPermissions(host: ReturnType<typeof fakeHost>, faces: Partial<Pick<PermissionsSectionProps, 'ask' | 'review'>> & { readonly mcp?: ReturnType<typeof mcpConsentForm> } = {}) {
  const { mcp = mcpConsentForm(), ...rest } = faces
  const props = {
    t: makeTranslate(en), close: () => {}, fetch: host.fetch, ask: async () => false, review: async () => undefined,
    useMcpConsent: bindSnapshotSelector(mcp.form), useMcpConsentMutation: bindSnapshotSelector(mcp.writer.state), setMcpAsk: mcp.writer.set.bind(mcp.writer),
    ...rest,
  } as PermissionsSectionProps
  return render(<PermissionsSection {...props} />)
}

describe('which MCP servers ask first', () => {
  const pending = { [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([]) }

  it('offers three radio options in order, each with its sentence, and checks "Ask for project servers" when the row has no choice', async () => {
    renderPermissions(fakeHost(pending), { mcp: mcpConsentForm({}) })
    await settle()
    const group = screen.getByRole('radiogroup', { name: en['mcp.ask.title'] })
    const radios = within(group).getAllByRole('radio')
    expect(radios).toHaveLength(3)
    expect(MCP_ASK_MODES).toEqual(['outside', 'always', 'never'])
    for (const [index, mode] of MCP_ASK_MODES.entries()) {
      expect(radios[index]?.getAttribute('value')).toBe(mode)
      expect(within(group).getByText(en[`mcp.ask.${mode}.title`])).toBeTruthy()
      expect(within(group).getByText(en[`mcp.ask.${mode}.description`])).toBeTruthy()
    }
    expect(en['mcp.ask.outside.title']).toBe('Ask for project servers')
    expect(radios.map(radio => (radio as HTMLInputElement).checked)).toEqual([true, false, false])
  })

  it('shows the saved choice', async () => {
    renderPermissions(fakeHost(pending), { mcp: mcpConsentForm({ ask: 'never' }) })
    await settle()
    expect(screen.getAllByRole('radio').map(radio => (radio as HTMLInputElement).checked)).toEqual([false, false, true])
  })

  it('writes only the row\'s ask field with the chosen value, and shows the value the Host accepted', async () => {
    const mcp = mcpConsentForm({})
    renderPermissions(fakeHost(pending), { mcp })
    await settle()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(en['mcp.ask.always.title']) }))
    await settle()
    expect(mcp.mutate.mock.calls).toEqual([[[{ op: 'set', path: ['ask'], value: 'always' }]]])
    expect((screen.getByRole('radio', { name: new RegExp(en['mcp.ask.always.title']) }) as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByText(en['mcp.ask.failed'])).toBeNull()
  })

  it('says so, and keeps the earlier choice, when the Host refuses the write', async () => {
    const mcp = mcpConsentForm({ ask: 'outside' }, false)
    renderPermissions(fakeHost(pending), { mcp })
    await settle()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(en['mcp.ask.never.title']) }))
    await settle()
    expect(screen.getByText(en['mcp.ask.failed']).getAttribute('role')).toBe('alert')
    expect(screen.getAllByRole('radio').map(radio => (radio as HTMLInputElement).checked)).toEqual([true, false, false])
  })

  it('shows no choice in a profile that does not serve the row', async () => {
    renderPermissions(fakeHost(pending))
    await settle()
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('has the zh copy for the choice', () => {
    for (const key of ['mcp.ask.title', 'mcp.ask.failed', 'mcp.card.title', 'mcp.card.remote'] as const) expect(zh[key]).not.toBe(en[key])
  })
})

/**
 * Render the External agents section over a fake home.
 * @param host - the fake home.
 * @param settings - the external-agent consent row's form; by default a profile that does not serve the row.
 * @returns the render result.
 */
function renderExternalAgents(host: ReturnType<typeof fakeHost>, settings = agentSettingsForm()) {
  const props = {
    t: makeTranslate(en), close: () => {}, fetch: host.fetch,
    useAgentSettings: bindSnapshotSelector(settings.form),
    useAgentSettingsMutation: bindSnapshotSelector(settings.writer.state),
    setAgentSetting: (field: keyof DelegationConsentSettings, value: DelegationConsentSettings[keyof DelegationConsentSettings]) => settings.writer.set(field, value as never),
  } as ExternalAgentsSectionProps
  return render(<ExternalAgentsSection {...props} />)
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
    renderPermissions(fakeHost({ [`GET ${PERMISSION_ROUTES.workspaces}`]: { status: 200, body: { workspaces: [ON, other], everywhere: { on: false } } } }), { ask })
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
      [`GET ${PERMISSION_ROUTES.workspaces}`]: { status: 200, body: { workspaces: [ON], everywhere: { on: false } } },
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
    expect(screen.getByRole('status').textContent).toBe('files started. Chats can use its tools from your next message.')
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

  it('tells a phone to approve at the computer, and offers no answer', async () => {
    renderPermissions(fakeHost({ [`GET ${PERMISSION_ROUTES.workspaces}`]: REMOTE, [`GET ${MCP_CONSENT_ROUTES.pending}`]: REMOTE }))
    await settle()
    const line = screen.getByRole('status').textContent
    expect(line).toContain(FULL_ACCESS_COMMAND)
    expect(line).toContain(MCP_COMMAND)
    expect(line).not.toContain(AGENTS_COMMAND)
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
      [`GET ${PERMISSION_ROUTES.workspaces}`]: { status: 200, body: { workspaces: [], everywhere: { on: false }, storeProblem: 'the file is not JSON' } },
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
    expect(screen.getAllByText(en['permissions.loading'])).toHaveLength(2)
  })

  it('says when no workspace has full access and no MCP server waits, and why no grant counts when the grants cannot be read', async () => {
    renderPermissions(fakeHost({
      [`GET ${PERMISSION_ROUTES.workspaces}`]: { status: 200, body: { workspaces: [OFF], everywhere: { on: false }, storeProblem: 'unreadable' } },
      [`GET ${MCP_CONSENT_ROUTES.pending}`]: SERVERS([]),
    }))
    await settle()
    expect(screen.getByText(en['access.none'])).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe(en['access.storeProblem'].replace('{problem}', 'unreadable'))
    expect(screen.getByText(en['mcp.none'])).toBeTruthy()
  })

  it('says only that the profile does not ask, where the plugins are not mounted', async () => {
    renderPermissions(fakeHost())
    await settle()
    expect(screen.getByText(en['access.unavailable'])).toBeTruthy()
    expect(screen.getByText(en['mcp.unavailable'])).toBeTruthy()
  })
})

describe('the External agents section', () => {
  it('lists each external agent allowed per workspace and revokes it in one click', async () => {
    const host = fakeHost({
      [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([GRANT]),
      [`POST ${DELEGATION_CONSENT_ROUTES.revoke}`]: { status: 200, body: { revoked: true } },
    })
    renderExternalAgents(host)
    await settle()
    const row = rowOf('Claude Code')
    expect(within(row).getByText(GRANT.workspace)).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: en['agents.revoke'] }))
    await settle()
    expect(host.received.find(request => request.key === `POST ${DELEGATION_CONSENT_ROUTES.revoke}`)?.body).toEqual({ workspace: GRANT.workspace, provider: 'claude-code' })
    expect(screen.getByRole('status').textContent).toBe(`Claude Code asks again before it starts in ${GRANT.workspace}.`)
  })

  it('says no agent starts without asking, and names a grants file it cannot read', async () => {
    renderExternalAgents(fakeHost({ [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([], 'not JSON') }))
    await settle()
    expect(screen.getByText(en['agents.none'])).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe(makeTranslate(en)('agents.storeProblem', { problem: 'not JSON' }))
  })

  it('names a refused revoke and keeps the grant listed', async () => {
    const host = fakeHost({
      [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([GRANT]),
      [`POST ${DELEGATION_CONSENT_ROUTES.revoke}`]: REMOTE,
    })
    renderExternalAgents(host)
    await settle()
    fireEvent.click(within(rowOf('Claude Code')).getByRole('button', { name: en['agents.revoke'] }))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(makeTranslate(en)('loopback', { action: en['action.changeAgent'] }))
    expect(rowOf('Claude Code')).toBeTruthy()
  })

  it('shows each agent\'s level, writes a chosen one, and names the sandbox Claude Code lacks', async () => {
    const settings = agentSettingsForm({ enabled: true, runTimeoutMinutes: 30, fullAccessStartsAgents: true, claudeCodeLevel: 'standard', codexLevel: 'careful' })
    const levels: LevelsAnswer = { levels: [
      { provider: 'claude-code', agent: 'Claude Code', level: 'standard', sandboxMissing: { tools: ['socat'], installCommand: 'sudo apt install bubblewrap socat' } },
      { provider: 'codex', agent: 'Codex', level: 'careful' },
    ] }
    renderExternalAgents(fakeHost({ [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([]), [`GET ${DELEGATION_CONSENT_ROUTES.levels}`]: { status: 200, body: levels } }), settings)
    await settle()
    const claude = screen.getByRole('group', { name: 'Claude Code' })
    expect((within(claude).getByRole('radio', { name: /Standard/ }) as HTMLInputElement).checked).toBe(true)
    expect((within(screen.getByRole('group', { name: 'Codex' })).getByRole('radio', { name: /Careful/ }) as HTMLInputElement).checked).toBe(true)
    expect(claude.querySelector('[data-sandbox-missing]')?.textContent).toContain('sudo apt install bubblewrap socat')
    fireEvent.click(within(claude).getByRole('radio', { name: /Careful/ }))
    await settle()
    expect(settings.set).toHaveBeenLastCalledWith('claudeCodeLevel', 'careful')
    expect(en['levels.mcp']).toContain('MCP')
  })

  it('lets a remote studio only tighten a level', async () => {
    const settings = agentSettingsForm({ enabled: true, runTimeoutMinutes: 30, fullAccessStartsAgents: true, claudeCodeLevel: 'own', codexLevel: 'own' })
    renderExternalAgents(fakeHost({ [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: REMOTE }), settings)
    await settle()
    const claude = screen.getByRole('group', { name: 'Claude Code' })
    expect((within(claude).getByRole('radio', { name: /Unrestricted/ }) as HTMLInputElement).disabled).toBe(true)
    expect((within(claude).getByRole('radio', { name: /Careful/ }) as HTMLInputElement).disabled).toBe(false)
    expect((within(claude).getByRole('radio', { name: /Your own Claude Code settings/ }) as HTMLInputElement).disabled).toBe(false)
    expect((within(screen.getByRole('group', { name: 'Codex' })).getByRole('radio', { name: /Your own Codex settings/ }) as HTMLInputElement).disabled).toBe(false)
  })

  it('names only its own agent in the own-settings choice, and keeps a level description in one block beside its radio', async () => {
    renderExternalAgents(fakeHost({ [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([]) }), agentSettingsForm({ enabled: true, runTimeoutMinutes: 30, fullAccessStartsAgents: true, claudeCodeLevel: 'standard', codexLevel: 'standard' }))
    await settle()
    for (const [group, own, other] of [['Claude Code', 'Claude Code', 'Codex'], ['Codex', 'Codex', 'Claude Code']] as const) {
      const radio = within(screen.getByRole('group', { name: group })).getByRole('radio', { name: new RegExp(`Your own ${own} settings`, 'u') })
      const label = radio.closest('label')!
      expect(label.textContent).not.toContain(other)
      expect(label.textContent).toContain(`Your own ${own} settings decide.`)
      // The description wraps inside the text block, so it hangs under the name and not under the radio button.
      expect(radio.nextElementSibling?.tagName).toBe('SPAN')
      expect(radio.nextElementSibling?.textContent).toContain('Delorun sets nothing.')
      expect([...label.childNodes].filter(node => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '')).toEqual([])
    }
  })

  it('states the missing sandbox as a note on the level it affects, not as an error', async () => {
    const levels: LevelsAnswer = { levels: [
      { provider: 'claude-code', agent: 'Claude Code', level: 'standard', sandboxMissing: { tools: ['bubblewrap', 'socat'], installCommand: 'sudo apt install bubblewrap socat' } },
      { provider: 'codex', agent: 'Codex', level: 'careful' },
    ] }
    const settings = agentSettingsForm({ enabled: true, runTimeoutMinutes: 30, fullAccessStartsAgents: true, claudeCodeLevel: 'standard', codexLevel: 'careful' })
    renderExternalAgents(fakeHost({ [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([]), [`GET ${DELEGATION_CONSENT_ROUTES.levels}`]: { status: 200, body: levels } }), settings)
    await settle()
    const note = screen.getByRole('group', { name: 'Claude Code' }).querySelector('[data-sandbox-missing]')!
    expect(note.textContent).toBe('Careful needs bubblewrap and socat: sudo apt install bubblewrap socat. Until then, Standard runs without a command sandbox.')
    expect(note.className).not.toMatch(/boxFailed/u)
  })

  it('words the chip for a level, with the missing sandbox', () => {
    const t = makeTranslate(en)
    expect(levelChipText(t, { level: 'standard' })).toBe('Standard')
    expect(levelChipText(t, { level: 'standard', sandboxMissing: { tools: ['socat'], installCommand: 'x' } })).toBe('Standard · no sandbox')
    expect(levelChipText(t, { level: 'own' })).toBe('Your own settings')
  })

  it('turns the external-agent consent off and on, and writes a whole run time limit within its bounds', async () => {
    const settings = agentSettingsForm({ enabled: true, runTimeoutMinutes: 30, fullAccessStartsAgents: true, claudeCodeLevel: 'standard', codexLevel: 'standard' })
    renderExternalAgents(fakeHost({ [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([]) }), settings)
    await settle()
    const ask = screen.getByRole('switch', { name: en['agents.ask.title'] })
    expect(ask.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(ask)
    await settle()
    expect(settings.set).toHaveBeenLastCalledWith('enabled', false)
    fireEvent.click(screen.getByRole('switch', { name: en['agents.ask.title'] }))
    await settle()
    expect(settings.set).toHaveBeenLastCalledWith('enabled', true)
    const limit = screen.getByRole('spinbutton', { name: en['agents.limit.title'] })
    for (const typed of ['0', '1441', '2.5', '', '30']) {
      fireEvent.change(limit, { target: { value: typed } })
      fireEvent.blur(limit)
      await settle()
    }
    // An entry outside 1 to 1440 whole minutes, or the saved value, writes nothing and shows the saved value again.
    expect(settings.set).toHaveBeenCalledTimes(2)
    expect((limit as HTMLInputElement).value).toBe('30')
    fireEvent.change(limit, { target: { value: '90' } })
    fireEvent.keyDown(limit, { key: '0' })
    expect(settings.set).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(limit, { key: 'Enter' })
    await settle()
    expect(settings.set).toHaveBeenLastCalledWith('runTimeoutMinutes', 90)
    expect((limit as HTMLInputElement).value).toBe('90')
  })

  it('turns Full access chats starting agents without asking off and on, and on a remote studio says turning it on needs the computer', async () => {
    const settings = agentSettingsForm({ enabled: true, runTimeoutMinutes: 30, fullAccessStartsAgents: true, claudeCodeLevel: 'standard', codexLevel: 'standard' })
    const view = renderExternalAgents(fakeHost({ [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([]) }), settings)
    await settle()
    const full = screen.getByRole('switch', { name: en['agents.fullAccess.title'] })
    expect(full.getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByText(en['agents.fullAccess.computerOnly'])).toBeNull()
    fireEvent.click(full)
    await settle()
    expect(settings.set).toHaveBeenLastCalledWith('fullAccessStartsAgents', false)
    fireEvent.click(screen.getByRole('switch', { name: en['agents.fullAccess.title'] }))
    await settle()
    expect(settings.set).toHaveBeenLastCalledWith('fullAccessStartsAgents', true)
    view.unmount()
    const off = agentSettingsForm({ enabled: true, runTimeoutMinutes: 30, fullAccessStartsAgents: false, claudeCodeLevel: 'standard', codexLevel: 'standard' })
    renderExternalAgents(fakeHost({ [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: REMOTE }), off)
    await settle()
    const remote = screen.getByRole('switch', { name: en['agents.fullAccess.title'] })
    expect(remote.hasAttribute('disabled') || remote.getAttribute('aria-disabled') === 'true').toBe(true)
    expect(screen.getByText(en['agents.fullAccess.computerOnly'])).toBeTruthy()
  })

  it('says a refused settings write was not saved and keeps the value the Host holds', async () => {
    const settings = agentSettingsForm({ enabled: true, runTimeoutMinutes: 30, fullAccessStartsAgents: true, claudeCodeLevel: 'standard', codexLevel: 'standard' })
    settings.set.mockResolvedValueOnce(false)
    renderExternalAgents(fakeHost({ [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: GRANTS([]) }), settings)
    await settle()
    fireEvent.click(screen.getByRole('switch', { name: en['agents.ask.title'] }))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(en['agents.settings.failed'])
    expect(screen.getByRole('switch', { name: en['agents.ask.title'] }).getAttribute('aria-checked')).toBe('true')
  })

  it('on a remote studio, disables the external-agent settings and says turning the consent off needs the computer', async () => {
    const settings = agentSettingsForm({ enabled: true, runTimeoutMinutes: 30, fullAccessStartsAgents: true, claudeCodeLevel: 'standard', codexLevel: 'standard' })
    renderExternalAgents(fakeHost({ [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: REMOTE }), settings)
    await settle()
    const ask = screen.getByRole('switch', { name: en['agents.ask.title'] })
    expect(ask.hasAttribute('disabled') || ask.getAttribute('aria-disabled') === 'true').toBe(true)
    expect((screen.getByRole('spinbutton', { name: en['agents.limit.title'] }) as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText(en['agents.ask.computerOnly'])).toBeTruthy()
    fireEvent.click(ask)
    await settle()
    expect(settings.set).not.toHaveBeenCalled()
  })

  it('tells a phone to approve at the computer, and offers no answer', async () => {
    renderExternalAgents(fakeHost({ [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: REMOTE }))
    await settle()
    expect(screen.getByRole('status').textContent).toContain(AGENTS_COMMAND)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says it is loading until the list answers, and that the profile does not ask where the plugin is not mounted', async () => {
    const { unmount } = renderExternalAgents({ fetch: async () => new Promise<Response>(() => {}), received: [], script: {} })
    await settle()
    // One line in the grants list and one in the plans and limits card.
    expect(screen.getAllByText(en['permissions.loading'])).toHaveLength(2)
    unmount()
    renderExternalAgents(fakeHost())
    await settle()
    expect(screen.getByText(en['agents.unavailable'])).toBeTruthy()
  })
})

describe('the consents copy', () => {
  it('has the same keys in English and Chinese', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})

describe('dangerous mode', () => {
  const EVERYWHERE_ON = { status: 200, body: { on: true, grantedAt: '2026-11-13T09:00:00.000Z' } }
  const EVERYWHERE_ROUTE: RouteKey = `GET ${PERMISSION_ROUTES.everywhere}`

  it('asks the dialog as before while the home says it is off, and when a locked device cannot read the state', async () => {
    for (const read of [{ status: 200, body: { on: false } }, refusal(403, 'LOOPBACK_REQUIRED'), undefined]) {
      const host = fakeHost({ ...REVIEWED_OFF, ...read === undefined ? {} : { [EVERYWHERE_ROUTE]: read } })
      const askSwitch = vi.fn(async (): Promise<SwitchAnswer> => 'submit')
      await expect(confirmPermissionSwitch(host.fetch, { ask: vi.fn(), askSwitch }, 'chat-1', 'danger-full-access')).resolves.toBe('submit')
      expect(askSwitch).toHaveBeenCalledTimes(1)
    }
  })

  it('submits the switch to full access with no dialog while it is on, also where the home refuses the review', async () => {
    const host = fakeHost({ [EVERYWHERE_ROUTE]: EVERYWHERE_ON, [`POST ${PERMISSION_ROUTES.review}`]: REMOTE })
    const ask = vi.fn(async () => true)
    const askSwitch = vi.fn(async (): Promise<SwitchAnswer> => 'submit')
    await expect(confirmPermissionSwitch(host.fetch, { ask, askSwitch }, 'chat-1', 'danger-full-access')).resolves.toBe('submit')
    expect(ask).not.toHaveBeenCalled()
    expect(askSwitch).not.toHaveBeenCalled()
  })

  it('offers Allow for this chat on a remote studio and hides the approve-at-the-computer line while it is on', async () => {
    const host = fakeHost({ [EVERYWHERE_ROUTE]: EVERYWHERE_ON, [`POST ${PERMISSION_ROUTES.review}`]: REMOTE })
    const props = choiceProps(host)
    render(<AllowForChat {...props} />)
    await settle()
    expect(allowForChat()).toBeTruthy()
    cleanup()
    render(<FullAccessAction {...actionProps(host)} />)
    await settle()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows the Settings card with the date, the way to turn it off, and turns it off in one click', async () => {
    const host = fakeHost({
      [`GET ${PERMISSION_ROUTES.workspaces}`]: { status: 200, body: { workspaces: [OFF], everywhere: { on: true, grantedAt: '2026-11-13T09:00:00.000Z' } } },
      [EVERYWHERE_ROUTE]: EVERYWHERE_ON,
      [`POST ${PERMISSION_ROUTES.everywhereOff}`]: { status: 200, body: { on: false } },
    })
    renderPermissions(host, {})
    await settle()
    expect(screen.getByText(en['everywhere.on'])).toBeTruthy()
    // The command is inline code, never text with literal backticks around it.
    expect(screen.getByText('delorun setup prompts').tagName).toBe('CODE')
    expect(document.body.textContent).not.toContain('`')
    host.script[EVERYWHERE_ROUTE] = { status: 200, body: { on: false } }
    fireEvent.click(screen.getByRole('button', { name: en['everywhere.off'] }))
    await settle()
    expect(host.received.some(entry => entry.key === `POST ${PERMISSION_ROUTES.everywhereOff}`)).toBe(true)
    expect(screen.getByText(en['everywhere.turnedOff'])).toBeTruthy()
    expect(screen.queryByText(en['everywhere.on'])).toBeNull()
  })

  it('shows the card on a remote studio, whose workspace listing is refused, from the state route alone', async () => {
    const host = fakeHost({ [`GET ${PERMISSION_ROUTES.workspaces}`]: REMOTE, [EVERYWHERE_ROUTE]: EVERYWHERE_ON })
    renderPermissions(host, {})
    await settle()
    expect(screen.getByText(en['everywhere.on'])).toBeTruthy()
  })

  it('offers the Face ID confirmation, not the computer, on a remote studio that cannot list its workspaces while the mode is on', async () => {
    const host = fakeHost({ [`GET ${PERMISSION_ROUTES.workspaces}`]: REMOTE, [EVERYWHERE_ROUTE]: EVERYWHERE_ON })
    renderPermissions(host, {})
    await settle()
    // Pins the mode check in the section: with the mode off the same refusal shows the computer line.
    expect(screen.getByText(en.confirmHere)).toBeTruthy()
    expect(screen.queryByText(en['permissions.remote'], { exact: false })).toBeNull()
  })

  it('offers the Face ID confirmation in External agents while the mode is on, and the computer line while it is off', async () => {
    for (const mode of [true, false]) {
      const everywhere = { status: 200, body: mode ? { on: true } : { on: false } }
      const agents = renderExternalAgents(fakeHost({ [`GET ${DELEGATION_CONSENT_ROUTES.grants}`]: REMOTE, [EVERYWHERE_ROUTE]: everywhere }))
      await settle()
      expect(screen.queryByText(en.confirmHere) !== null, `agents, mode ${String(mode)}`).toBe(mode)
      expect(screen.queryByText(en['agents.remote'], { exact: false }) !== null, `agents, mode ${String(mode)}`).toBe(!mode)
      agents.unmount()
    }
  })

  it('shows no card while it is off', async () => {
    renderPermissions(fakeHost({ [`GET ${PERMISSION_ROUTES.workspaces}`]: { status: 200, body: { workspaces: [OFF], everywhere: { on: false } } } }), {})
    await settle()
    expect(screen.queryByText(en['everywhere.heading'])).toBeNull()
  })
})

describe('a refusal that needs Face ID or the PIN', () => {
  const REFUSAL: Answer = { status: 403, body: { error: 'ELEVATION_REQUIRED', message: 'Confirm first' } }

  it('is worded as a Face ID confirmation, never an unlock', () => {
    const text = consentFailureText(makeTranslate(en), { kind: 'face' })
    expect(text).toBe(en['gate.face'])
    expect(text).not.toMatch(/unlock/i)
  })

  // Returning the `unlock` failure kind brings back the Unlock button and its sentence in the full-access dialog.
  it('shows the full-access dialog the Face ID line, with no Unlock button, and keeps the dialog open', async () => {
    const host = fakeHost({ [`POST ${PERMISSION_ROUTES.setFullAccess}`]: REFUSAL })
    const consent = createFullAccessConsentSource(host.fetch)
    void consent.ask(OFF)
    consent.confirm()
    await settle()
    renderConsent(consent)
    expect(screen.getByRole('alert').textContent).toBe(en['gate.face'])
    expect(screen.queryByRole('button', { name: /unlock/i })).toBeNull()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
