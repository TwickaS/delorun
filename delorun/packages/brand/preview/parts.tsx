/**
 * The parts the website and the docs draw with, in a light and a dark column: the section heading, the button states
 * with the unavailable one beside an ordinary one, the tabs, the code block, the frame, the switch, the toast and the
 * simplified chat. Run
 * with `BRAND_PREVIEW_SEAM=web vite --config delorun/packages/brand/preview/vite.config.ts` and open `/parts.html`; it is
 * not part of any build.
 */
import '../src/fonts.css'
import { useState, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, CodeBlock, Frame, SectionHeading, TabList, TabPanel } from '../src/index.ts'
import { Composer, MessageBubble, ToolCard, Transcript } from '../src/replica/index.ts'
import { Switch } from '#upstream'
import { showToast, ToastCard, Toaster } from '../src/toast.web.tsx'

const CHAPTERS = [{ id: 'ask', label: 'Ask for a plugin' }, { id: 'change', label: 'Change Delorun' }, { id: 'review', label: 'Review' }] as const
type Chapter = typeof CHAPTERS[number]['id']

const COPY = { copyLabel: 'Copy command', copiedLabel: 'Copied', failedLabel: 'Copy failed' }

const still = <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--dl-text-muted)', fontSize: 14 }}>A still of the studio</div>

/** One column of parts in the given colour scheme. */
function Column({ scheme }: { scheme: 'light' | 'dark' }) {
  const [chapter, setChapter] = useState<Chapter>('ask')
  const [on, setOn] = useState(true)
  const idBase = `chapters-${scheme}`
  const note = `desktop-note-${scheme}`
  const style: CSSProperties = { colorScheme: scheme, display: 'grid', gap: 28, alignContent: 'start', padding: 24, background: 'var(--dl-surface)', color: 'var(--dl-text)', fontFamily: 'var(--dl-font-sans)', minWidth: 0 }
  return (
    <section style={style} aria-label={`${scheme} scheme`}>
      <SectionHeading title="Make it yours" lead="Change the page, see the entry Delorun would write, and go back." />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <Button variant="primary">Install</Button>
        <Button>Read the docs</Button>
        <Button unavailable aria-describedby={note}>Download for macOS</Button>
        <span id={note} style={{ color: 'var(--dl-text-muted)', fontSize: 13 }}>The desktop app is not available yet.</span>
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        <TabPanel idBase={idBase} selected={chapter}><p style={{ margin: 0 }}>{CHAPTERS.find(item => item.id === chapter)?.label}</p></TabPanel>
        <TabList label="Chapters" idBase={idBase} tabs={CHAPTERS} selected={chapter} onSelect={setChapter} />
      </div>
      <CodeBlock code="npm install -g delorun" {...COPY} />
      <CodeBlock code="delorun" caption="Then start it" size="lg" {...COPY} />
      <CodeBlock code="npm install -g delorun" caption="The main button" emphasis="primary" {...COPY} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Frame width={480} height={300} label="The studio, still" still={still} />
        <Frame width={480} height={300} label="The studio, live" still={still}><div style={{ padding: 16, fontSize: 14 }}>The live replica</div></Frame>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}><Switch checked={on} label="Delorun look" onChange={setOn} />Delorun look</label>
      <div style={{ display: 'grid', gridTemplateRows: 'minmax(0, 360px) auto', gap: 12 }}>
        <Transcript label="Conversation">
          <MessageBubble from="person">Make the page header blue.</MessageBubble>
          <MessageBubble from="agent"><p>I will change the header colour.</p><p>One moment.</p></MessageBubble>
          <ToolCard title="Bash" command="npm run build" status="running" statusLabel="Running" />
          <ToolCard title="Bash" command="git diff --stat" status="done" output={' header.css | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)'} />
        </Transcript>
        <Composer label="Message" placeholder="Ask for a change" value="Now make the footer" sendLabel="Send" typing />
      </div>
      <ToastCard message="Theme changed to Ocean" action={{ label: 'Back to Soft', onClick: () => {} }} onDone={() => {}} />
      <Button style={{ justifySelf: 'start' }} onClick={() => { showToast({ message: `Theme changed to ${scheme === 'dark' ? 'Ocean' : 'Forest'}`, action: { label: 'Back to Soft', onClick: () => {} } }) }}>Show a toast</Button>
    </section>
  )
}

document.body.style.cssText = 'margin:0;background:var(--dl-surface)'

createRoot(document.getElementById('root') as HTMLElement).render(
  <>
    <main style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
      <Column scheme="light" />
      <Column scheme="dark" />
    </main>
    <Toaster label="Notifications" />
  </>,
)
