/**
 * The home page: a mosaic of real studio screenshots in the shape of the Delorun mark, with the promise and the install
 * command over it; a zoom into the film of one real job; the case for tinkerers; the wall of every screenshot; the
 * install command again.
 *
 * @module @delorun/website/home/home
 */
import { useLayoutEffect, useRef } from 'react'
import { Film } from './Film.tsx'
import { MosaicHero } from './Mosaic.tsx'
import { Closing, InstallBlock, HomeFrame, Reasons } from './Shell.tsx'
import { Wall } from './Wall.tsx'
import s from './home.module.css'

/** B's headline, broken where it should break, and the paragraph under it (L71). */
const HEADLINE = {
  lines: ['Bring your own', 'everything.'],
  lead: 'Your models and keys. Your plugins. Your look. Your agents. Delorun is an AI agent harness on your own computer, and every part of it is yours to swap.',
} as const

/** The largest size a headline line may take, in pixels. */
const HEADLINE_MAX = 150

/**
 * A headline set line by line, each line as large as the column allows: the widest line fills the column's width, up to
 * a ceiling. The stylesheet's size shows until the page has measured it.
 * @param props.lines - the lines, broken where they should break.
 * @returns the heading.
 */
function FitHeadline({ lines }: { lines: readonly string[] }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => {
    const el = heading.current
    if (el === null) return
    const fit = () => {
      el.style.fontSize = ''
      const spans = [...el.querySelectorAll<HTMLElement>('span')]
      const widest = Math.max(...spans.map(span => span.getBoundingClientRect().width))
      const size = parseFloat(getComputedStyle(el).fontSize)
      const column = el.parentElement ?? el
      const pad = getComputedStyle(column)
      const room = column.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight)
      if (widest > 0) el.style.fontSize = `${Math.min(HEADLINE_MAX, Math.floor(size * room / widest * 0.98))}px`
    }
    fit()
    void document.fonts.ready.then(fit)
    addEventListener('resize', fit)
    return () => removeEventListener('resize', fit)
  }, [lines])
  return (
    <h1 ref={heading} id="home-hero" className={s.displayB}>
      {lines.map(line => <span key={line} className={s.displayLine}>{line}</span>)}
    </h1>
  )
}

/**
 * The home page.
 * @returns the page.
 */
export function Home() {
  const { lines, lead } = HEADLINE
  return (
    <HomeFrame>
      <MosaicHero next="home-film">
        <FitHeadline lines={lines} />
        <p className={s.leadB}>{lead}</p>
        <InstallBlock />
      </MosaicHero>
      <Film id="home-film" heading="Watch it do one real job" />
      <Reasons heading="Built for people who take their tools apart." />
      <Wall id="home-wall" heading="Every screen, one wall." lead="Every picture here is a real screenshot of the Delorun studio. Press one to see it large." />
      <Closing heading="One line to start." />
    </HomeFrame>
  )
}
