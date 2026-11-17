/**
 * The home page's five claims: numbered rows, each a link to the guide page that states the claim.
 *
 * @module @delorun/website/claims
 */
import { SECTIONS_EN as WORDS } from '../site/words/sections-en.ts'
import { GRID, SPACE } from './grid.ts'

/** The claims' rules as Tailwind classes; colours, durations and easing are the brand's tokens. */
const CLASSES = {
  claims: 'col-span-full m-0 list-none border-b border-(--dl-border) p-0',
  // Below 640 px the number sits above its claim; from 640 px it takes a narrow column beside it, and from 1024 px the
  // first grid column, with the headline on columns 2 to 7 and the second line beside it on 8 to 12.
  claim: 'group grid grid-cols-1 items-baseline gap-x-(--grid-gap) gap-y-1 border-t border-(--dl-border) py-(--dl-space-5) text-(--dl-text) no-underline focus-visible:rounded-(--dl-radius-xs) focus-visible:[outline:var(--dl-focus-ring)] focus-visible:[outline-offset:var(--dl-focus-ring-offset)] sm:grid-cols-[3rem_minmax(0,1fr)] lg:grid-cols-12',
  number: 'text-[clamp(18px,0.95rem_+_0.8vw,28px)] font-medium leading-[1.2] text-(--dl-text-muted) tabular-nums lg:col-span-1',
  text: 'grid gap-y-1 lg:col-start-2 lg:col-end-13 lg:grid-cols-subgrid lg:items-baseline',
  sentence: 'max-w-[40ch] lg:col-span-6 lg:last:col-span-10 text-[clamp(20px,0.95rem_+_0.9vw,28px)] font-medium leading-[1.2] tracking-[-0.02em] text-pretty underline decoration-transparent decoration-1 underline-offset-[0.18em] transition-[text-decoration-color] duration-(--dl-duration-quick) ease-(--dl-ease) group-focus-visible:decoration-current pointer-fine:group-hover:decoration-current',
  detail: 'max-w-[60ch] lg:col-span-5 text-[clamp(16px,0.95rem_+_0.25vw,18px)] leading-normal text-(--dl-text-muted) text-pretty',
} as const

/** One claim: a headline line, an optional second line, and the guide page that states it. */
export interface Claim {
  readonly text: string
  readonly detail?: string
  readonly href: string
}

/**
 * The five claims: numbered rows, each a headline line and a short second line, each row a link to the guide page that
 * states it. A claim without a second line is one sentence set at the headline's size.
 * @param props.items - the claims, in order; the dictionary's by default.
 * @returns the section.
 */
export function Claims({ items = WORDS.claims.items }: { items?: readonly Claim[] }) {
  return (
    <section aria-labelledby="claims" className={`${GRID} ${SPACE.normal}`}>
      <h2 id="claims" className="sr-only">{WORDS.claims.heading}</h2>
      <ol role="list" className={CLASSES.claims}>
        {items.map((claim, index) => (
          <li key={claim.href}>
            <a href={claim.href} className={CLASSES.claim}>
              <span className={CLASSES.number} aria-hidden="true">{index + 1}</span>
              <span className={CLASSES.text}>
                <span className={CLASSES.sentence}>{claim.text}</span>
                {claim.detail === undefined ? null : <span className={CLASSES.detail}>{claim.detail}</span>}
              </span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  )
}
