/** A static page that renders the downloads panel against the fake source: `?scene=` picks the state, `?dark=1` the scheme. */
import '../../../../packages/client/ui-theme/src/styles/design-platform.css'
import '../../../../packages/client/ui-theme/src/styles/base.css'
import '../../../../packages/client/ui-theme/src/styles/gradient-shadow-text.css'
import { ICON_SYMBOLS } from '@deepseek-ai/dsh-client-ui-primitives'
import { createRoot } from 'react-dom/client'
import { DownloadsCard } from '../src/client/Card.tsx'
import { fallbackTranslate as t } from '../src/client/locales.ts'
import { useDownloadsModel } from '../src/client/model.ts'
import { DownloadsSheet, OnboardingDownloadsRow } from '../src/client/Phone.tsx'
import { createFakeDownloadsSource, type DownloadItem } from '../src/client/source.ts'

const item = (key: string, title: string, patch: Partial<DownloadItem> = {}): DownloadItem => ({ key, title, state: 'queued', receivedBytes: 0, ...patch })
const MIXED = [
  item('a', 'Chat states', { state: 'ready' }),
  item('b', 'Cost meter', { state: 'downloading', receivedBytes: 6_400_000, totalBytes: 9_100_000 }),
  item('c', 'Trash', { state: 'verifying' }),
  item('d', 'Workspaces', { state: 'queued', position: 1 }),
  item('e', 'Theme', { state: 'queued', position: 2 }),
]
const SCENES: Record<string, DownloadItem[]> = {
  mixed: MIXED,
  done: [item('a', 'Chat states', { state: 'ready' }), item('b', 'Cost meter', { state: 'ready' }), item('c', 'Trash', { state: 'ready' }), item('d', 'Workspaces', { state: 'ready' }), item('e', 'Theme', { state: 'ready' })],
  failure: [MIXED[0] as DownloadItem, item('b', 'Cost meter', { state: 'failed', failure: { code: 'offline', message: 'No connection. Check your network and try again.' } }), item('c', 'Trash', { state: 'ready' })],
  unlock: [item('a', 'Chat states', { state: 'waiting-for-unlock' }), item('b', 'Cost meter', { state: 'waiting-for-unlock' })],
}
const params = new URLSearchParams(location.search)
const scene = params.get('scene') ?? 'mixed'
const source = createFakeDownloadsSource(SCENES[scene] ?? MIXED)
if (params.get('dark') === '1') document.body.setAttribute('data-ds-dark-theme', '')
// The Delorun look's accent; stock tokens use black as the brand colour.
document.body.style.setProperty('--dsw-alias-brand-primary', 'oklch(0.62 0.17 255)')
// The icon sprite the theme plugin mounts in the studio.
const sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
sprite.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden')
for (const [id, markup] of Object.entries(ICON_SYMBOLS)) {
  const root = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement
  const symbol = document.createElementNS('http://www.w3.org/2000/svg', 'symbol')
  for (const { name, value } of root.attributes) if (!['width', 'height', 'xmlns', 'class', 'aria-hidden'].includes(name)) symbol.setAttribute(name, value)
  symbol.id = id
  symbol.append(...[...root.childNodes].map(node => document.importNode(node, true)))
  sprite.append(symbol)
}
document.body.prepend(sprite)
const space = [2, 4, 6, 8, 12, 16, 20, 24, 32]
for (const [index, px] of space.entries()) document.documentElement.style.setProperty(`--delorun-space-${String(index + 1)}`, `${String(px)}px`)

function Page() {
  const mode = params.get('mode') ?? 'card'
  const model = useDownloadsModel(source, 3_600_000)
  return (
    <div style={{ minHeight: '100vh', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ padding: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 500 }}>Set up Delorun</h1>
        <p style={{ color: 'var(--dsw-alias-label-secondary)', maxWidth: 480 }}>Pick the plugins that suit you. They install in the background while you carry on.</p>
      </div>
      {mode === 'card' && <DownloadsCard model={model} source={source} t={t} />}
      {mode === 'sheet' && <DownloadsSheet model={model} source={source} t={t} />}
      {mode === 'row' && (
        <div style={{ position: 'fixed', inset: 'auto 0 0 0', padding: '12px 16px', background: 'var(--dsw-alias-bg-layer-1)', borderTop: '0.5px solid var(--dsw-alias-border-l1)' }}>
          <OnboardingDownloadsRow source={source} t={t} summaryMs={3_600_000} />
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span style={{ flex: 1, color: 'var(--dsw-alias-label-secondary)' }}>Skip</span>
            <button type="button" style={{ minHeight: 44 }}>Back</button>
            <button type="button" style={{ minHeight: 44 }}>Continue</button>
          </div>
        </div>
      )}
    </div>
  )
}
createRoot(document.getElementById('root') as HTMLElement).render(<Page />)
