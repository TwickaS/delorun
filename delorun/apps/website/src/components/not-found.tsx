/**
 * The page for an address no page has: the mark with its plug pulled out, one sentence and the way home. The build
 * writes it as 404.html without the router's scripts, keeping only the head script that follows a look carried in the
 * link, so it is plain HTML and CSS.
 *
 * @module @delorun/website/not-found
 */
import { Link, MARK } from '@brand'
import { COPY } from '@/site/copy.ts'
import { Frame } from '@/components/layout.tsx'
import { GRID } from '@/components/grid.ts'

/** How far the plug sits from the hole, in the mark's 32 by 32 units: down and to the right, clear of the nut. */
const PLUG_OUT = { dx: 15, dy: 14 } as const

/**
 * The mark with nothing in its hole and the plug beside it, always peach.
 * @param props.size - the nut's width in pixels.
 * @returns the drawing.
 */
function UnpluggedMark({ size }: { size: number }) {
  const label = COPY.notFound.markLabel
  return (
    <svg width={size * 1.6} height={size * 1.5} viewBox="0 0 51 48" role="img" aria-label={label} focusable="false" className="text-(--dl-text)">
      <path d={MARK.nut} fill="currentColor" fillRule="evenodd" />
      <circle cx={MARK.plug.cx + PLUG_OUT.dx} cy={MARK.plug.cy + PLUG_OUT.dy} r={MARK.plug.r} fill="var(--dl-peach)" />
    </svg>
  )
}

/**
 * The not-found page.
 * @returns the page.
 */
export function NotFound() {
  const copy = COPY.notFound
  return (
    <Frame signup={false}>
      <main className={`${GRID} gap-y-8 pt-16 lg:pt-32`}>
        <div className="col-span-full lg:col-span-4"><UnpluggedMark size={120} /></div>
        <div className="col-span-full lg:col-start-5 lg:col-end-12">
          <h1 className="text-4xl font-semibold tracking-tight text-balance">{copy.title}</h1>
          <p className="mt-4 text-lg text-(--dl-text-muted)">{copy.text}</p>
          <p className="mt-8"><Link href="/">{copy.home}</Link></p>
        </div>
      </main>
    </Frame>
  )
}
