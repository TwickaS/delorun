/**
 * A page for the layout screenshots: the real `PaneLayout` full-window with plausible chat panes, or the real `LayoutPicker` in a
 * popover-like card and a footer-like strip, over the real colour tokens. Query: `layout` (a layout choice id or `picker`),
 * `panes` (the total including the main chat) and `theme` (`light` or `dark`).
 */
import '../../../../../../packages/client/ui-theme/src/styles/base.css'
import '../../../../../../packages/client/ui-theme/src/styles/design-platform.css'
import { ICON_SYMBOLS } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { createRoot } from 'react-dom/client'
import type { CSSProperties, JSX } from 'react'
import { DEFAULT_MULTIVIEW_SETTINGS, type MultiviewSettings } from '../../../src/config.ts'
import { MultiviewStore } from '../../../src/entry/state.ts'
import {
  arrangeLayout, buildPreset, DEFAULT_LAYOUT_LIMITS, DEFAULT_PRESET_OPTIONS, LAYOUT_CHOICE_IDS, LayoutPicker, PaneLayout, shapeOf,
  type LayoutChoiceId, type PaneActivity, type PaneId,
} from '../../../src/layout/index.ts'
import { en } from '../../../src/layout/locales.ts'
import type { MultiviewService } from '../../../src/client/contract.ts'
import { MultiviewSettingsSection, type MultiviewSettingsSectionProps } from '../../../src/panel/settings/Section.tsx'

/** The document icon sprite the theme plugin mounts, so the primitives' icons draw. */
function mountIconSprite(): void {
  const ns = 'http://www.w3.org/2000/svg'
  const sprite = document.createElementNS(ns, 'svg')
  sprite.setAttribute('aria-hidden', 'true')
  sprite.style.cssText = 'position: absolute; width: 0; height: 0; overflow: hidden'
  for (const [id, markup] of Object.entries(ICON_SYMBOLS)) {
    const root = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement
    const symbol = document.createElementNS(ns, 'symbol')
    for (const { name, value } of root.attributes) if (!['width', 'height', 'xmlns', 'class', 'aria-hidden'].includes(name)) symbol.setAttribute(name, value)
    symbol.id = id
    symbol.append(...[...root.childNodes].map(node => document.importNode(node, true)))
    sprite.append(symbol)
  }
  document.body.prepend(sprite)
}
mountIconSprite()

const params = new URLSearchParams(location.search)
const dark = params.get('theme') === 'dark'
// The studio's own switch: `body[data-ds-dark-theme]` selects the dark tokens, `color-scheme` follows it.
document.body.toggleAttribute('data-ds-dark-theme', dark)
document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
document.documentElement.dataset.dsThemeSource = dark ? 'dark' : 'light'

const sid = SessionId
const pane = (value: string): PaneId => value as PaneId
const t = (key: keyof typeof en): string => en[key]

interface Agent { readonly name: string; readonly mono: string; readonly colour: string; readonly lines: readonly string[]; readonly reply: string }

const AGENTS: readonly Agent[] = [
  { name: 'Main chat', mono: 'M', colour: '#4d6bfe', reply: 'Ask Main chat…', lines: ['Plan the billing refactor in three steps.', 'Step one moves the invoice rounding into its own module.', 'I will ask the Reviewer to read the diff once the tests pass.', 'Tests are running now; the Migration writer has the schema change.'] },
  { name: 'Reviewer', mono: 'R', colour: '#7c5cff', reply: 'Reply to Reviewer…', lines: ['Reading the diff in src/billing/invoice.ts.', 'The rounding helper is used in two places; both look right.', 'One comment on the error path in applyCredit.'] },
  { name: 'Migration writer', mono: 'MW', colour: '#0f9d8a', reply: 'Reply to Migration writer…', lines: ['Wrote 0042_invoice_totals.sql with a reversible step.', 'Waiting for you to approve the schema change.'] },
  { name: 'Test runner', mono: 'T', colour: '#3b82f6', reply: 'Reply to Test runner…', lines: ['Running billing tests: 118 passed, 2 running.', 'Slowest file is invoice.spec.ts at 3.1 s.', 'No failures so far.'] },
  { name: 'Docs pass', mono: 'D', colour: '#e0a100', reply: 'Reply to Docs pass…', lines: ['Updating the billing guide for the new rounding rule.', 'Two screenshots need a refresh.'] },
  { name: 'Type check', mono: 'TC', colour: '#64748b', reply: 'Reply to Type check…', lines: ['tsc finished with no errors in 48 s.', 'Checked 1,204 files.'] },
  { name: 'Changelog', mono: 'C', colour: '#c2410c', reply: 'Reply to Changelog…', lines: ['Added an entry under Fixed: invoice totals round half up.', 'Linked the pull request.'] },
  { name: 'Release notes', mono: 'RN', colour: '#be185d', reply: 'Reply to Release notes…', lines: ['Drafted two sentences for the release notes.', 'Waiting for the changelog to settle.'] },
]

const ids: readonly PaneId[] = AGENTS.map((_, index) => pane(index === 0 ? 'main' : `agent-${index}`))
const status = (index: number): 'Working' | 'Done' => (index === 0 || index % 2 === 1 ? 'Working' : 'Done')

const mutedText: CSSProperties = { color: 'var(--dsw-alias-label-secondary)' }

function PaneBody({ agent }: { agent: Agent }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--dsw-alias-bg-base)' }}>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {agent.lines.map(line => <p key={line} style={{ margin: 0, fontSize: 13, lineHeight: 1.45, ...mutedText }}>{line}</p>)}
        <div style={{ height: 8, width: '62%', borderRadius: 4, background: 'var(--dsw-alias-bg-layer-2)' }} />
        <div style={{ height: 8, width: '44%', borderRadius: 4, background: 'var(--dsw-alias-bg-layer-2)' }} />
      </div>
      <div style={{ margin: '0 12px 20px', padding: '8px 12px', fontSize: 13, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-tertiary)' }}>
        {agent.reply}
      </div>
    </div>
  )
}

function Header({ agent, state, grip }: { agent: Agent; state: string; grip: JSX.Element | null }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, minHeight: 36, padding: '0 8px' }}>
      {grip}
      <span style={{ flex: 'none', width: 22, height: 22, borderRadius: 6, display: 'grid', placeItems: 'center', background: agent.colour, color: '#fff', fontSize: 10, fontWeight: 600 }}>{agent.mono}</span>
      <strong style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.name}</strong>
      <span style={{ marginInlineStart: 'auto', fontSize: 12, ...mutedText }}>{state}</span>
    </div>
  )
}

/** A flat tab in the window's bottom-right corner, inside the bottom margin of the reply boxes so it covers no pane content. */
const chip: CSSProperties = {
  position: 'fixed', insetInlineEnd: 0, insetBlockEnd: 0, zIndex: 10, padding: '1px 10px', borderRadius: '8px 0 0 0', fontSize: 11, lineHeight: '14px', fontWeight: 600,
  background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-base)', pointerEvents: 'none',
}

function LayoutView({ choice, count }: { choice: LayoutChoiceId; count: number }): JSX.Element {
  const slots = ids.slice(0, count)
  const [main, ...others] = slots as [PaneId, ...PaneId[]]
  const area = { width: innerWidth, height: innerHeight }
  const activity = new Map<PaneId, PaneActivity>(slots.map((slot, index): [PaneId, PaneActivity] => [slot, status(index) === 'Working' ? 'large' : 'small']))
  const shape = choice === 'yours'
    ? shapeOf(buildPreset('main-stack', main, others, { mainSide: 'right', stackStyle: 'grid' }), [main, ...others])
    : undefined
  const model = arrangeLayout({
    arrangement: choice,
    slots,
    shape,
    options: { ...DEFAULT_PRESET_OPTIONS, area, limits: DEFAULT_LAYOUT_LIMITS, ...(choice === 'mosaic' ? { activity } : {}) },
    limits: DEFAULT_LAYOUT_LIMITS,
  })
  const agentOf = (id: PaneId): { agent: Agent; index: number } => { const index = ids.indexOf(id); return { agent: AGENTS[index]!, index } }
  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh' }}>
      <PaneLayout
        model={model}
        main={main}
        limits={DEFAULT_LAYOUT_LIMITS}
        onModelChange={() => {}}
        labels={{ separator: 'Resize panes', region: 'Multiview', tabList: 'Panes', grip: 'Move pane' }}
        renderPane={id => <PaneBody agent={agentOf(id).agent} />}
        renderHeader={(id, _state, controls) => <Header agent={agentOf(id).agent} state={status(agentOf(id).index)} grip={controls.grip as JSX.Element} />}
        renderTab={id => {
          const { agent, index } = agentOf(id)
          return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 16, height: 16, borderRadius: 4, background: agent.colour, display: 'inline-block' }} />
            {agent.name}<span style={{ fontSize: 11, ...mutedText }}>{status(index)}</span>
          </span>
        }}
      />
      <span style={chip}>{en[`choice.${choice}`]} · {count} panes</span>
    </div>
  )
}

/** The Settings page's Multiview section in a 760 px column over a fake settings row, with "Yours" saved so its tile shows. */
function SettingsView(): JSX.Element {
  // The Delorun look's spacing steps and accent, which the studio's theme plugin sets and the shared settings controls read.
  for (const [index, px] of [2, 4, 6, 8, 12, 16, 20, 24, 32].entries()) document.documentElement.style.setProperty(`--delorun-space-${String(index + 1)}`, `${String(px)}px`)
  document.body.style.setProperty('--dsw-alias-brand-primary', 'oklch(0.62 0.17 255)')
  const [main, ...others] = ids.slice(0, 4) as [PaneId, ...PaneId[]]
  const yours = shapeOf(buildPreset('main-stack', main, others, { mainSide: 'right', stackStyle: 'grid' }), [main, ...others])
  const snapshot = {
    status: 'ready' as const,
    value: { ...DEFAULT_MULTIVIEW_SETTINGS, yours, defaultLayout: 'main-stack' as const },
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
  }
  const props = Object.assign({} as MultiviewSettingsSectionProps, {
    multiview: Object.assign({} as MultiviewService, { resetToAuto: () => {} }),
    form: { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => true, set: async () => true, unset: async () => true },
    t: (key: keyof typeof en, params?: Record<string, unknown>): string => en[key].replace(/\{(\w+)\}/g, (match, name: string) => (params !== undefined && name in params ? String(params[name]) : match)),
    mainChat: () => undefined,
  })
  return (
    <div style={{ width: 760, boxSizing: 'border-box', margin: '0 auto', padding: '32px 0 48px' }}>
      <MultiviewSettingsSection {...props} />
    </div>
  )
}

function PickerView(): JSX.Element {
  const settings = createSnapshotStore<MultiviewSettings>({ ...DEFAULT_MULTIVIEW_SETTINGS })
  const store = new MultiviewStore({
    settings,
    persistence: { load: () => undefined, save: () => {} },
    windowArea: () => ({ width: 4000, height: 3000 }),
  })
  store.attachHost({ write: async (patch) => { settings.set({ ...settings.getSnapshot(), ...patch }); return true } })
  const chat = sid('chat')
  store.pinAll(chat, [sid('a1'), sid('a2'), sid('a3'), sid('a4')])
  store.chooseLayout(chat, 'main-stack')
  const card: CSSProperties = { boxSizing: 'border-box', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 12, boxShadow: '0 12px 32px rgba(0, 0, 0, .16)' }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 28, padding: 32 }}>
      <div style={{ ...card, width: 360, padding: 8 }}>
        <LayoutPicker chat={chat} multiview={store} t={t as never} variant="grid" />
      </div>
      <div style={{ ...card, width: 320, padding: 8, borderRadius: 8 }}>
        <LayoutPicker chat={chat} multiview={store} t={t as never} variant="row" />
      </div>
    </div>
  )
}

const layout = params.get('layout') ?? 'picker'
const count = Number(params.get('panes') ?? '3')
const root = createRoot(document.getElementById('root')!)
if (layout === 'picker') root.render(<PickerView />)
else if (layout === 'settings') root.render(<SettingsView />)
else if ((LAYOUT_CHOICE_IDS as readonly string[]).includes(layout)) root.render(<LayoutView choice={layout as LayoutChoiceId} count={count} />)
else throw new Error(`unknown layout ${layout}`)
