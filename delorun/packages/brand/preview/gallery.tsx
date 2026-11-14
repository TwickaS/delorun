/**
 * A local gallery of the brand components for screenshots: the notice dialog of `@delorun/bundle-local`, which draws a
 * brand `Button` inside upstream's `Modal` on the studio's own stylesheets, above the component set on the page.
 * Run with `vite --config delorun/packages/brand/preview/vite.config.ts`; it is not part of any build.
 */
import '../../../../packages/client/ui-theme/src/styles/design-platform.css'
import '../../../../packages/client/ui-theme/src/styles/base.css'
import '../src/fonts.css'
import { createRoot } from 'react-dom/client'
import { Button, Card, Link, Mark, Notice, OutcomePanel, PinDots, Pill, StatusCard, TextField } from '../src/index.ts'
import { DelorunNotice } from '../../bundle-local/src/client/DelorunNotice.tsx'
import { en } from '../../bundle-local/src/client/locales.ts'

const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16v1" /></svg>

const params = new URLSearchParams(location.search)
document.documentElement.style.colorScheme = params.get('scheme') === 'dark' ? 'dark' : 'light'
document.body.style.cssText = 'margin:0;padding:24px;background:var(--dl-surface);color:var(--dl-text);font-family:var(--dl-font-sans)'

createRoot(document.getElementById('root') as HTMLElement).render(
  <div style={{ display: 'grid', gap: 16, maxWidth: 520 }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Mark size={32} /><strong>Delorun brand components</strong></div>
    <div style={{ display: 'flex', gap: 8 }}><Button variant="primary">Primary</Button><Button>Secondary</Button><Button variant="destructive">Destructive</Button><Button variant="ghost">Ghost</Button></div>
    <TextField label="Workspace name" help="Shown in the sidebar" defaultValue="Delorun" />
    <Card title="Status"><StatusCard Icon={Icon} on title="PIN mode" detail="Asks for a PIN on new devices" pill="On" /></Card>
    <Notice tone="warning" Icon={Icon} title="Paused">Too many tries. Wait a minute.</Notice>
    <OutcomePanel tone="error" Icon={Icon} title="Cannot reach home">Check the address.</OutcomePanel>
    <PinDots count={3} minimum={6} />
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Pill tone="accent">Selected</Pill><Pill>Plain</Pill><Link href="#">A link in text-safe peach</Link></div>
    {params.has('studio') ? <DelorunNotice complete={() => {}} t={key => en[key]} {...({} as object)} /> : null}
  </div>,
)
