/**
 * The replica's local preview: the hero session at the width the query names (`?width=desktop|phone|pair|responsive`,
 * default desktop, and `?opens=<chapter id>`) and the session of changes and setup versions, in the look the query names (`?look=ocean&scheme=dark`, read
 * by the sites' own head script). Run with `vite --config src/replica/preview/vite.config.ts` in `delorun/apps/website`;
 * it is not part of the site's build.
 * @module @delorun/website/replica/preview/main
 */
import '../../styles/app.css'
import { createRoot } from 'react-dom/client'
import { LOOK_SCRIPT } from '@design/head-script.ts'
import { ReplicaFrame, ReplicaStyle } from '../ReplicaFrame.tsx'
import type { SessionId } from '../model.ts'

// The head script removes the look's parameters from the address, so the preview reads its own first.
const params = new URLSearchParams(location.search)
const WIDTHS = ['desktop', 'phone', 'pair', 'responsive'] as const
const width = WIDTHS.find(each => each === params.get('width')) ?? 'desktop'
const session: SessionId = params.get('session') === 'changes-and-versions' ? 'changes-and-versions' : 'ordinary-work'
const head = document.createElement('script')
head.textContent = LOOK_SCRIPT
document.head.append(head)

createRoot(document.getElementById('root') as HTMLElement).render(
  <main style={{ boxSizing: 'border-box', maxWidth: 1200, margin: '0 auto', padding: 'clamp(16px, 3vw, 32px)' }}>
    <>
      <ReplicaStyle />
      <ReplicaFrame session={session} width={width} opens={params.get('opens') ?? undefined} />
    </>
  </main>,
)
