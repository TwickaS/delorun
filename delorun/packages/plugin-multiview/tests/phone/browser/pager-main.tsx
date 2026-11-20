import '../../../../../../packages/client/ui-theme/src/styles/design-platform.css'
import { useCallback, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import type { PaneId } from '../../../src/layout/index.ts'
import { PhonePager, PhoneSwitch, type PhonePage } from '../../../src/phone/index.ts'

/** What the browser runner reads: every page change the pager reported, and the bodies mounted now. */
interface PagerProbe {
  changes: string[]
  active: string
  bodies: () => string[]
}

declare global {
  interface Window {
    __pager: PagerProbe
  }
}

const id = (value: string): PaneId => value as PaneId
const query = new URLSearchParams(location.search)
if (query.get('theme') === 'dark') document.body.setAttribute('data-ds-dark-theme', '')

const PAGES: (PhonePage & { mark: string; status: string; hue: string })[] = [
  { id: id('main'), label: 'Main', needsAttention: false, mark: 'D', status: 'Port the garden planner to Vite', hue: '#e07048' },
  { id: id('claude'), label: 'Claude Code', needsAttention: true, mark: 'CC', status: 'Needs approval', hue: '#7c3aed' },
  { id: id('codex'), label: 'Codex', needsAttention: false, mark: 'CX', status: 'Working · 48s', hue: '#0f9488' },
  { id: id('explorer'), label: 'Explorer', needsAttention: false, mark: 'EX', status: 'Done · 1m 23s', hue: '#4f6fd8' },
]

const Mark = ({ page }: { page: (typeof PAGES)[number] }): JSX.Element => (
  <span style={{ display: 'inline-flex', width: 24, height: 24, borderRadius: 7, background: page.hue, color: '#fff', fontSize: 10, fontWeight: 600, alignItems: 'center', justifyContent: 'center' }}>{page.mark}</span>
)

/** A page body in the shape of lane B's pane: header line, a transcript that scrolls, a reply box. */
function Body({ page }: { page: (typeof PAGES)[number] }): JSX.Element {
  return (
    <div data-body={page.id} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: '1px solid var(--dsw-alias-border-l3)' }}>
        <Mark page={page} />
        <strong style={{ flex: 1 }}>{page.label}</strong>
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{page.status}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 12px' }} data-scroller={page.id}>
        {Array.from({ length: 40 }, (_, index) => (
          <p key={index} style={{ margin: '0 0 10px', padding: index % 3 === 0 ? '8px 10px' : 0, borderRadius: 10, background: index % 3 === 0 ? 'var(--dsw-alias-bg-layer-2)' : 'transparent' }}>
            {index % 3 === 0 ? `Task from Delorun: step ${index}` : `${page.label} reads the project and reports on step ${index}.`}
          </p>
        ))}
      </div>
      <div style={{ padding: '8px 12px' }}>
        <input aria-label={`Reply to ${page.label}`} placeholder={`Reply to ${page.label}…`} style={{ width: '100%', boxSizing: 'border-box', height: 44, padding: '0 12px', font: 'inherit', color: 'inherit', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 12 }} />
      </div>
    </div>
  )
}

function App(): JSX.Element {
  const [active, setActive] = useState(id(query.get('start') ?? 'main'))
  const onActiveChange = useCallback((next: PaneId) => {
    window.__pager.changes.push(next)
    window.__pager.active = next
    setActive(next)
  }, [])
  const pages = PAGES.slice(0, Number(query.get('pages') ?? PAGES.length))
  return (
    <PhoneSwitch
      phone={(
        <PhonePager
          pages={pages}
          active={active}
          onActiveChange={onActiveChange}
          renderPage={pageId => <Body page={pages.find(page => page.id === pageId)!} />}
          renderChipIcon={pageId => <Mark page={pages.find(page => page.id === pageId)!} />}
          labels={{ region: 'Multiview', strip: 'Chats', attention: 'Needs your approval' }}
        />
      )}
      split={<div data-splits="" style={{ flex: 1, padding: 16 }}>Split layout ({active})</div>}
    />
  )
}

window.__pager = { changes: [], active: query.get('start') ?? 'main', bodies: () => [...document.querySelectorAll('[data-body]')].map(node => node.getAttribute('data-body')!) }
createRoot(document.getElementById('root')!).render(<App />)
