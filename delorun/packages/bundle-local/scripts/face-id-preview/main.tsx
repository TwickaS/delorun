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
import { PasskeyDevices } from '../../src/client/PasskeyDevices.tsx'
import { fakeApi, fakeBrowser } from '../../src/client/face-id-fake.ts'
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
const PASSKEY = { credentialId: 'BBBB', createdAt: NOW - 3 * DAY, lastUsedAt: NOW - DAY, synced: true }
const PHONE_DEVICES: readonly PasskeyDevice[] = [{ deviceId: 'this', label: 'This device', thisDevice: true, passkeys: [PASSKEY] }]
const COMPUTER_DEVICES: readonly PasskeyDevice[] = [
  { deviceId: 'd1', label: 'Vadim’s iPhone', thisDevice: false, passkeys: [PASSKEY] },
  { deviceId: 'd2', label: 'Work laptop in the office with a long name', thisDevice: false, passkeys: [{ ...PASSKEY, credentialId: 'CCCC', lastUsedAt: null, synced: false }] },
]
const noop = (): void => undefined

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
    default:
      return <p>Unknown screen {screen}</p>
  }
}

/* The studio sets the face and the page colours on `body`; the preview does the same. */
document.body.style.cssText = 'margin: 0; font-family: var(--dl-font-sans); background: var(--dsw-alias-bg-layer-0); color: var(--dsw-alias-label-primary);'
const query = new URLSearchParams(window.location.search)
if (query.get('theme') === 'dark') document.body.dataset.dsDarkTheme = ''
document.documentElement.style.colorScheme = query.get('theme') === 'dark' ? 'dark' : 'light'
const wrap = query.get('screen')?.startsWith('b4') === true || query.get('screen') === 'code-entry'
const screen = screenOf(query.get('screen') ?? '')
const root = document.getElementById('root')
if (root === null) throw new Error('no #root')
createRoot(root).render(wrap
  ? <div style={{ boxSizing: 'border-box', padding: 16, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', minHeight: '100dvh' }}>{screen}</div>
  : screen)
