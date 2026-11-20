/**
 * Entry of the Face ID screen preview: renders one screen of the Face ID client with the typed fakes, chosen by the URL
 * query `?screen=<name>&theme=dark|light`. `shoot.ts` loads each screen in Chromium; nothing here reaches the studio.
 * @module @delorun/bundle-local/scripts/face-id-preview/main
 */
import { createRoot } from 'react-dom/client'
import { ICON_SYMBOLS, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import '../../../../../packages/client/ui-theme/src/styles/base.css'
import '../../../../../packages/client/ui-theme/src/styles/design-platform.css'
import '../../../../../packages/client/ui-theme/src/styles/focus.css'
import '@delorun/brand/fonts.css'
import '@delorun/brand/tokens.css'
import { AddFaceId, FaceIdPairingStep, PasskeyCodeEntry } from '../../src/client/FaceIdEnrol.tsx'
import { answerActionOf } from '../../src/client/FaceIdAnswerAction.tsx'
import { FaceIdPin } from '../../src/client/FaceIdPin.tsx'
import { FaceIdSheet } from '../../src/client/FaceIdSheet.tsx'
import { FaceIdGrantFlow } from '../../src/client/FaceIdGrantFlow.tsx'
import { callActionOf } from '../../src/client/FaceIdGrantOverlay.tsx'
import { PasskeyDevices } from '../../src/client/PasskeyDevices.tsx'
import { fakeApi, fakeBrowser } from '../../src/client/face-id-fake.ts'
import { DevicesSection, type DevicesSectionProps } from '../../src/client/DevicesSection.tsx'
import { DEVICE_ROUTES, type HostFetch } from '../../src/client/devices-api.ts'
import { PASSKEY_ROUTES } from '../../src/client/face-id-api.ts'
import { FaceIdSection, type FaceIdSectionProps } from '../../src/client/FaceIdSection.tsx'
import { en as devicesEn } from '../../src/client/devices-locales.ts'
import { en } from '../../src/client/face-id-locales.ts'
import { TerminalGuide, type TerminalGuideProps } from '../../../../../packages/client/ui-sidebar-terminal/src/client/TerminalGuide.tsx'
import { en as terminalEn } from '../../../../../packages/client/ui-sidebar-terminal/src/client/locales.ts'
import type { FaceIdAction, PasskeyDevice } from '../../src/client/face-id-types.ts'

type Translate = Parameters<typeof FaceIdSheet>[0]['t']

/** The English copy, with `{name}` placeholders filled from the call's values, as the client test runtime does. */
const t = ((key: keyof typeof en, values?: Record<string, string>) =>
  en[key].replace(/\{(\w+)\}/g, (_match, name: string) => values?.[name] ?? '')) as Translate

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 18)
const ACTION: FaceIdAction = {
  title: 'Install “Reports”?',
  body: 'The plugin can read files in your workspaces and run commands after you approve each one.',
  items: ['Reports 1.2.0', 'Chart helpers 0.4.1', 'Spreadsheet export 2.0.0', 'Slide builder 0.9.3', 'Notes sync 1.1.0'],
  grant: { actions: [{ action: 'plugins/install', hash: 'h1' }] },
}
/** The sheet a phone shows when the home refuses a plugin install for want of a grant, as the Face ID step builds it. */
const INSTALL = await callActionOf(t, { action: 'plugin-packs/add', call: { method: 'POST', path: '/api/delorunPacks.add', body: { names: ['@delorun/reports'] } } })
/** Where the actions below happen, as a real request names it. */
const WHERE = { workspace: 'delorun', chat: 'Fix the tests' }
/** The shared sheet, as the Face ID step builds it for a refused call: terminal, full access, the update, an approval answer and an install. */
const SHEETS: Readonly<Record<string, FaceIdAction>> = {
  'a498-terminal': { ...await callActionOf(t, { action: 'terminal/create', call: { args: { request: { id: 't1' } } }, hold: { feature: 'terminal', id: 't1' } }), context: WHERE },
  'a498-fullaccess': { ...await callActionOf(t, { action: 'plugin-permission-defaults/set-full-access', call: { method: 'POST', path: '/api/full-access', body: { workspace: '/home/user/delorun', on: true, chat: 'c1' } } }), context: WHERE },
  'a498-approval': { ...answerActionOf(t, { sessionId: 'chat-1', callId: 'call-7', grants: 'external-agent', toolName: 'Claude Code' }), context: WHERE },
  'a498-update': { ...await callActionOf(t, { action: 'changes/update-begin', call: { method: 'POST', path: '/api/changes/update-begin', body: {} } }) },
  'a498-install': { ...INSTALL, context: WHERE },
}
const PASSKEY = { credentialId: 'BBBB', createdAt: NOW - 3 * DAY, lastUsedAt: NOW - DAY, synced: true }
const PHONE_DEVICES: readonly PasskeyDevice[] = [{ deviceId: 'this', label: 'This device', thisDevice: true, passkeys: [PASSKEY] }]
const COMPUTER_DEVICES: readonly PasskeyDevice[] = [
  { deviceId: 'd1', label: 'Vadim’s iPhone', thisDevice: false, passkeys: [PASSKEY] },
  { deviceId: 'd2', label: 'Work laptop in the office with a long name', thisDevice: false, passkeys: [{ ...PASSKEY, credentialId: 'CCCC', lastUsedAt: null, synced: false }] },
]
const noop = (): void => undefined

/**
 * The home a phone's Devices and Face ID sections read: reach ready, two approved devices and this phone's passkeys;
 * anything else needs the computer.
 * @param passkey - whether this phone holds a passkey.
 * @returns the request function.
 */
const phoneHome = (passkey: boolean): HostFetch => (input) => {
  const answers: Readonly<Record<string, unknown>> = {
    [PASSKEY_ROUTES.state]: { passkeys: passkey ? [PASSKEY] : [], ticket: false },
    [DEVICE_ROUTES.reachStatus]: { available: true, hasOwner: true, options: [{ option: 'tailscale-private', state: 'ready', address: 'https://home.example.ts.net' }] },
    // As the home answers a device: no addresses, approvers or first device, with this device's id and running unlocks.
    [DEVICE_ROUTES.devices]: {
      owner: { claimedAt: NOW - 3 * DAY },
      devices: [
        { id: 'a'.repeat(43), label: 'Vadim’s iPhone', platform: 'iOS', approvedAt: NOW - DAY, lastSignInAt: NOW - 3_600_000 },
        { id: 'b'.repeat(43), label: 'Work laptop', platform: 'macOS', approvedAt: NOW - 2 * DAY, lastSignInAt: null },
      ],
      current: 'a'.repeat(43),
      unlocks: [],
    },
  }
  const body = answers[String(input)]
  return Promise.resolve(body === undefined
    ? new Response(JSON.stringify({ error: 'LOOPBACK_REQUIRED', message: 'This needs you at your computer' }), { status: 403 })
    : new Response(JSON.stringify(body), { status: 200 }))
}

/** The English Devices copy, with `{name}` placeholders filled. */
const devicesT = ((key: keyof typeof devicesEn, values?: Record<string, string>) =>
  devicesEn[key].replace(/\{(\w+)\}/g, (_match, name: string) => values?.[name] ?? '')) as DevicesSectionProps['t']

/**
 * Settings → Devices and Settings → Face ID as a paired phone on a home with no PIN shows them, one after the other as
 * the settings page does.
 * @param props - whether the phone holds a passkey.
 * @returns the two sections.
 */
function PhoneDevices({ passkey }: { passkey: boolean }): ReactNode {
  const fetch = phoneHome(passkey)
  const faceId = {
    t, fetch, close: noop, atComputer: () => false, browser: fakeBrowser(),
    usePin: select => select({ phase: 'off', secret: 'pin' }),
  } as FaceIdSectionProps
  const props: DevicesSectionProps = {
    t: devicesT, fetch, close: noop,
    useUnlock: select => select({ place: 'device' }),
    usePairing: select => select({ place: 'remote', requests: [], view: undefined, open: undefined, quieted: [] }),
    usePairingForm: select => select({ status: 'ready', value: {}, base: undefined, user: undefined, revision: 1, writable: false }),
    usePairingMutation: select => select({ busy: false, failed: false }),
    startPairing: () => noop, setPairing: noop, openPairingCode: noop, declinePairing: noop,
  } as DevicesSectionProps
  return <div style={{ display: 'grid', gap: 32 }}><DevicesSection {...props} /><FaceIdSection {...faceId} /></div>
}

/**
 * A stand-in for the studio under a sheet: the chat's header and a few messages, so the dimmed backdrop reads as it does over the real page.
 * @param props.children - the sheet.
 * @returns the page with the sheet over it.
 */
function OverStudio({ children }: { readonly children: ReactNode }): ReactNode {
  const line = (width: string): ReactNode => <div style={{ height: 12, width, borderRadius: 6, background: 'var(--dsw-alias-border-l3)' }} />
  return <>
    <div style={{ padding: 16, display: 'grid', gap: 14, background: 'var(--dsw-alias-bg-layer-1)', minHeight: '100dvh', boxSizing: 'border-box' }}>
      <strong>delorun · Fix the tests</strong>
      {line('80%')}{line('62%')}{line('90%')}{line('45%')}{line('70%')}{line('85%')}{line('55%')}{line('75%')}
    </div>
    {children}
  </>
}

/**
 * The studio's worst stacking for the Face ID layer: an open studio Modal (z-index 1000, portalled to the body), a
 * terminal panel at the highest z-index, and the sheet rendered inside a small transformed box that clips its content.
 * @param props.children - the sheet or keypad.
 * @returns the screen.
 */
function OverOverlays({ children }: { readonly children: ReactNode }): ReactNode {
  return <>
    <Modal open onClose={noop} title="Turn on full access?" closeLabel="Close" description="The studio's consent dialog stands under the sheet." />
    <section data-sidebar-terminal="" style={{ position: 'fixed', inset: 0, zIndex: 2147483647, background: 'rgb(0 0 0 / 30%)', color: 'white', padding: 16 }}>Terminal panel</section>
    <div style={{ position: 'fixed', top: 0, left: 0, width: 10, height: 10, overflow: 'hidden', transform: 'translateZ(0)' }}>{children}</div>
  </>
}

/**
 * The right sidebar's New terminal entry with its Choose shell control, as the terminal provider draws it in the guide.
 * @returns the entry.
 */
function TerminalGuideEntry(): ReactNode {
  const props = {
    title: terminalEn.new, description: terminalEn.description, kind: 'terminal',
    t: (key: keyof typeof terminalEn) => terminalEn[key],
    useTabInfo: () => ({ tab: { actions: { openTab: noop } } }),
    useShortcuts: <S,>(select: (entries: readonly never[]) => S): S => select([]),
    loadShells: async () => ({ shells: [{ name: 'bash', path: '/bin/bash' }, { name: 'zsh', path: '/bin/zsh' }], selectedShell: '/bin/bash' }),
    selectShell: noop,
  } as TerminalGuideProps
  return <TerminalGuide {...props} />
}

/**
 * Build the chosen screen.
 * @param screen - the `screen` query value.
 * @returns the element, or an explanatory element for an unknown name.
 */
function screenOf(screen: string): ReactNode {
  switch (screen) {
    case 'b2-sheet':
      return <FaceIdSheet t={t} action={ACTION} kind="faceId" api={fakeApi()} browser={fakeBrowser()} hasPasskey fallback="pin"
        onGranted={noop} onCancel={noop} onFallback={noop} />
    case 'wire-install':
      return <FaceIdSheet t={t} action={INSTALL} kind="faceId" api={fakeApi()} browser={fakeBrowser()} hasPasskey fallback="pin"
        onGranted={noop} onCancel={noop} onFallback={noop} />
    case 'a498-terminal': case 'a498-fullaccess': case 'a498-approval': case 'a498-update': case 'a498-install':
      return <OverStudio><FaceIdGrantFlow t={t} action={SHEETS[screen] ?? ACTION} kind="faceId" api={fakeApi()} browser={fakeBrowser()} hasPasskey secret="pin" onGranted={noop} onCancel={noop} /></OverStudio>
    case 'a498-keypad':
      return <OverStudio><FaceIdGrantFlow t={t} action={SHEETS['a498-terminal'] ?? ACTION} kind="faceId" api={fakeApi()} browser={fakeBrowser()} hasPasskey={false} secret="pin" onGranted={noop} onCancel={noop} /></OverStudio>
    case 'b2-answer':
      return <FaceIdSheet t={t} action={answerActionOf(t, { sessionId: 'chat-1', callId: 'call-7', grants: 'external-agent', toolName: 'Claude Code' })} kind="faceId"
        api={fakeApi()} browser={fakeBrowser()} hasPasskey fallback="pin" onGranted={noop} onCancel={noop} onFallback={noop} />
    case 'b2-cancelled':
      return <FaceIdSheet t={t} action={ACTION} kind="faceId" api={fakeApi()} browser={fakeBrowser({ get: [{ kind: 'cancelled' }] })} hasPasskey fallback="pin"
        onGranted={noop} onCancel={noop} onFallback={noop} />
    case 'over-overlays':
      return <OverOverlays><FaceIdSheet t={t} action={ACTION} kind="faceId" api={fakeApi()} browser={fakeBrowser()} hasPasskey fallback="pin"
        onGranted={noop} onCancel={noop} onFallback={noop} /></OverOverlays>
    case 'pin-over-overlays':
      return <OverOverlays><FaceIdPin t={t} action={ACTION} api={fakeApi()} secret="pin" onGranted={noop} onBack={noop} onCancel={noop} /></OverOverlays>
    case 'b3-pin':
      return <FaceIdPin t={t} action={ACTION} api={fakeApi()} secret="pin" onGranted={noop} onBack={noop} onCancel={noop} />
    case 'b1-pairing':
      return <FaceIdPairingStep t={t} kind="faceId" api={fakeApi()} browser={fakeBrowser()} onDone={noop} onSkip={noop} />
    case 'b1-add':
      return <AddFaceId t={t} kind="faceId" api={fakeApi()} browser={fakeBrowser()} onDone={noop} onCancel={noop} />
    case 'b1-add-code':
      return <AddFaceId t={t} kind="faceId" api={fakeApi({ code: '48201935' })} browser={fakeBrowser()} onDone={noop} onCancel={noop} />
    case 'code-entry':
      return <PasskeyCodeEntry t={t} api={fakeApi({ pending: [{ requestId: 'r1', deviceId: 'd1', deviceLabel: 'Vadim’s iPhone', expiresAt: NOW + DAY }] })} onDone={noop} />
    case 'b4-phone':
      return <PasskeyDevices t={t} api={fakeApi({ devices: PHONE_DEVICES })} browser={fakeBrowser()} kind="faceId" atComputer={false} secret="pin"
        onAdd={noop} onAskComputer={noop} />
    case 'b4-computer':
      return <PasskeyDevices t={t} api={fakeApi({ devices: COMPUTER_DEVICES })} browser={fakeBrowser()} kind="faceId" atComputer secret="pin"
        onAdd={noop} onAskComputer={noop} />
    case 'icon-catalogue':
      return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, padding: 8, fontSize: 10 }}>{Object.keys(ICON_SYMBOLS).filter(id => id.endsWith('-medium')).map(id => <div key={id} style={{ display: 'grid', justifyItems: 'center', gap: 2 }}><svg width={28} height={28}><use href={`#${id}`} /></svg>{id.slice(9, -7)}</div>)}</div>
    case 'terminal-guide':
      return <TerminalGuideEntry />
    case 'devices-phone':
      return <PhoneDevices passkey />
    case 'devices-phone-nokey':
      return <PhoneDevices passkey={false} />
    default:
      return <p>Unknown screen {screen}</p>
  }
}

/* The studio's theme puts the product icons in a sprite that `<use href="#dsw-icon-…">` reads; the preview builds the same. */
const sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
sprite.setAttribute('aria-hidden', 'true')
sprite.style.cssText = 'position: absolute; width: 0; height: 0; overflow: hidden'
for (const [id, markup] of Object.entries(ICON_SYMBOLS)) {
  const root = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement
  const symbol = document.createElementNS('http://www.w3.org/2000/svg', 'symbol')
  for (const { name, value } of root.attributes) if (!['width', 'height', 'xmlns', 'class', 'aria-hidden'].includes(name)) symbol.setAttribute(name, value)
  symbol.id = id
  symbol.append(...[...root.childNodes].map(node => document.importNode(node, true)))
  sprite.append(symbol)
}
document.body.prepend(sprite)

/* The studio sets the face and the page colours on `body`; the preview does the same. */
document.body.style.cssText = 'margin: 0; font-family: var(--dl-font-sans); background: var(--dsw-alias-bg-layer-0); color: var(--dsw-alias-label-primary);'
const query = new URLSearchParams(window.location.search)
if (query.get('theme') === 'dark') document.body.dataset.dsDarkTheme = ''
document.documentElement.style.colorScheme = query.get('theme') === 'dark' ? 'dark' : 'light'
const wrap = query.get('screen')?.startsWith('b4') === true || query.get('screen') === 'code-entry' || query.get('screen')?.startsWith('devices-phone') === true || query.get('screen') === 'terminal-guide'
const screen = screenOf(query.get('screen') ?? '')
const root = document.getElementById('root')
if (root === null) throw new Error('no #root')
createRoot(root).render(wrap
  ? <div style={{ boxSizing: 'border-box', padding: 16, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', minHeight: '100dvh' }}>{screen}</div>
  : screen)
