/**
 * Entry of the Face ID screen preview: renders one screen of the Face ID client with the typed fakes, chosen by the URL
 * query `?screen=<name>&theme=dark|light`. `shoot.ts` loads each screen in Chromium; nothing here reaches the studio.
 * @module @delorun/bundle-local/scripts/face-id-preview/main
 */
import { createRoot } from 'react-dom/client'
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
import { callActionOf } from '../../src/client/FaceIdGrantOverlay.tsx'
import { PasskeyDevices } from '../../src/client/PasskeyDevices.tsx'
import { fakeApi, fakeBrowser } from '../../src/client/face-id-fake.ts'
import { DevicesSection, type DevicesSectionProps } from '../../src/client/DevicesSection.tsx'
import { DEVICE_ROUTES, type HostFetch } from '../../src/client/devices-api.ts'
import { en as devicesEn } from '../../src/client/devices-locales.ts'
import { en } from '../../src/client/face-id-locales.ts'
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
const PASSKEY = { credentialId: 'BBBB', createdAt: NOW - 3 * DAY, lastUsedAt: NOW - DAY, synced: true }
const PHONE_DEVICES: readonly PasskeyDevice[] = [{ deviceId: 'this', label: 'This device', thisDevice: true, passkeys: [PASSKEY] }]
const COMPUTER_DEVICES: readonly PasskeyDevice[] = [
  { deviceId: 'd1', label: 'Vadim’s iPhone', thisDevice: false, passkeys: [PASSKEY] },
  { deviceId: 'd2', label: 'Work laptop in the office with a long name', thisDevice: false, passkeys: [{ ...PASSKEY, credentialId: 'CCCC', lastUsedAt: null, synced: false }] },
]
const noop = (): void => undefined

/** The home a phone's Devices section reads: reach ready, two approved devices; anything else needs the computer. */
const PHONE_HOME: HostFetch = (input) => {
  const answers: Readonly<Record<string, unknown>> = {
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

/** The Devices section as a paired phone shows it. */
function PhoneDevices(): ReactNode {
  const props: DevicesSectionProps = {
    t: devicesT, fetch: PHONE_HOME, close: noop,
    useUnlock: select => select({ place: 'device' }),
    usePairing: select => select({ place: 'remote', requests: [], view: undefined, open: undefined, quieted: [] }),
    usePairingForm: select => select({ status: 'ready', value: {}, base: undefined, user: undefined, revision: 1, writable: false }),
    usePairingMutation: select => select({ busy: false, failed: false }),
    startPairing: () => noop, setPairing: noop, openPairingCode: noop, declinePairing: noop,
  } as DevicesSectionProps
  return <DevicesSection {...props} />
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
    case 'b2-answer':
      return <FaceIdSheet t={t} action={answerActionOf(t, { sessionId: 'chat-1', callId: 'call-7', grants: 'external-agent', toolName: 'Claude Code' })} kind="faceId"
        api={fakeApi()} browser={fakeBrowser()} hasPasskey fallback="pin" onGranted={noop} onCancel={noop} onFallback={noop} />
    case 'b2-cancelled':
      return <FaceIdSheet t={t} action={ACTION} kind="faceId" api={fakeApi()} browser={fakeBrowser({ get: [{ kind: 'cancelled' }] })} hasPasskey fallback="pin"
        onGranted={noop} onCancel={noop} onFallback={noop} />
    case 'b3-pin':
      return <FaceIdPin t={t} action={ACTION} api={fakeApi()} secret="pin" onGranted={noop} onBack={noop} />
    case 'b1-pairing':
      return <FaceIdPairingStep t={t} kind="faceId" api={fakeApi()} browser={fakeBrowser()} onDone={noop} onSkip={noop} />
    case 'b1-add':
      return <AddFaceId t={t} kind="faceId" api={fakeApi()} browser={fakeBrowser()} onDone={noop} onCancel={noop} />
    case 'b1-add-code':
      return <AddFaceId t={t} kind="faceId" api={fakeApi({ code: '48201935' })} browser={fakeBrowser()} onDone={noop} onCancel={noop} />
    case 'code-entry':
      return <PasskeyCodeEntry t={t} api={fakeApi({ pending: [{ requestId: 'r1', deviceId: 'd1', deviceLabel: 'Vadim’s iPhone', expiresAt: NOW + DAY }] })} onDone={noop} />
    case 'b4-phone':
      return <PasskeyDevices t={t} api={fakeApi({ devices: PHONE_DEVICES })} browser={fakeBrowser()} kind="faceId" atComputer={false} secret="pin" hasPasskey
        onAdd={noop} onAskComputer={noop} />
    case 'b4-computer':
      return <PasskeyDevices t={t} api={fakeApi({ devices: COMPUTER_DEVICES })} browser={fakeBrowser()} kind="faceId" atComputer secret="pin" hasPasskey={false}
        onAdd={noop} onAskComputer={noop} />
    case 'devices-phone':
      return <PhoneDevices />
    default:
      return <p>Unknown screen {screen}</p>
  }
}

/* The studio sets the face and the page colours on `body`; the preview does the same. */
document.body.style.cssText = 'margin: 0; font-family: var(--dl-font-sans); background: var(--dsw-alias-bg-layer-0); color: var(--dsw-alias-label-primary);'
const query = new URLSearchParams(window.location.search)
if (query.get('theme') === 'dark') document.body.dataset.dsDarkTheme = ''
document.documentElement.style.colorScheme = query.get('theme') === 'dark' ? 'dark' : 'light'
const wrap = query.get('screen')?.startsWith('b4') === true || query.get('screen') === 'code-entry' || query.get('screen') === 'devices-phone'
const screen = screenOf(query.get('screen') ?? '')
const root = document.getElementById('root')
if (root === null) throw new Error('no #root')
createRoot(root).render(wrap
  ? <div style={{ boxSizing: 'border-box', padding: 16, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', minHeight: '100dvh' }}>{screen}</div>
  : screen)
