/**
 * The setup strip's still: the strip as it stands after choosing Ocean in a fresh studio, drawn in Ocean, with a caption
 * that says so. The page renders it on the server and keeps it until the strip's own script has loaded, and for good
 * with scripts off. It is plain markup with no state, and it imports none of the live strip, so it stays light in the
 * page's first script; its studio words and its entry are copies that `tests/strip.spec.ts` keeps equal to the studio's.
 *
 * @module website/strip/still
 */
import { KNOWN_LOOKS, type AccentId, type LookId } from '@design/looks.ts'
import { STRIP_COPY } from './copy.ts'
import css from './strip.module.css'

const copy = STRIP_COPY.en

/** The look the still shows. */
export const STILL_LOOK_ID: LookId = 'ocean'

/** The entry the studio writes after choosing Ocean in a fresh studio. */
export const STILL_ENTRY = `- id: delorun-theme
  name: "@delorun/plugin-theme"
  config:
    studioAdditions: true
    palette: ocean
`

/**
 * A theme tile's picture: the theme's page in light and in dark, each with a line of text and an accent pill. Each half
 * carries the look itself, so the looks stylesheet's `light-dark()` colours resolve in that half's own colour scheme.
 * @param props.look - the theme.
 * @param props.accent - the accent the custom theme shows.
 * @returns the picture.
 */
export function Swatch({ look, accent }: { readonly look: LookId; readonly accent: AccentId }) {
  const custom = look === 'custom' ? accent : undefined
  return (
    <span className={css.swatch}>
      <span className={css.half} data-half="light" data-look={look} data-accent={custom}><span className={css.line} /><span className={css.pill} /></span>
      <span className={css.half} data-half="dark" data-look={look} data-accent={custom}><span className={css.line} /><span className={css.pill} /></span>
    </span>
  )
}

/**
 * A row of choices drawn as the studio's segmented control, one of them chosen.
 * @param props.label - the row's name.
 * @param props.choices - the choices' names.
 * @param props.chosen - the index of the chosen one.
 * @returns the row.
 */
function Segments({ label, choices, chosen }: { readonly label: string; readonly choices: readonly string[]; readonly chosen: number }) {
  return (
    <div className={css.group}>
      <span className={css.label}>{label}</span>
      <ul className={css.segments}>
        {choices.map((choice, index) => <li key={choice} className={css.segment} aria-current={index === chosen ? 'true' : undefined}>{choice}</li>)}
      </ul>
    </div>
  )
}

/**
 * The still, in the same box as the live strip.
 * @returns the still.
 */
export function SetupStripStill() {
  const words = copy.still
  return (
    <div className={css.strip} data-setup-strip="still" data-look={STILL_LOOK_ID}>
      <div className={`${css.body} grid grid-cols-4 gap-x-(--grid-gap) lg:grid-cols-12`}>
        <p className={`${css.stillCaption} col-span-full`}>{words.caption}</p>
        <div className={`${css.controls} col-span-full lg:col-span-5 min-[1440px]:col-span-4`}>
          <div className={css.group}>
            <span className={css.label}>{words.themes}</span>
            <ul className={`${css.tiles} ${css.stillTiles}`}>
              {KNOWN_LOOKS.map(id => (
                <li key={id} className={css.stillTile} aria-current={id === STILL_LOOK_ID ? 'true' : undefined}>
                  <Swatch look={id} accent="peach" />
                  {words.theme[id]}
                </li>
              ))}
            </ul>
          </div>
          <Segments label={words.mode} choices={words.modes} chosen={0} />
          <Segments label={words.density} choices={words.densities} chosen={1} />
        </div>
        <div className={`${css.record} col-span-full grid gap-x-(--grid-gap) lg:col-span-7 min-[1440px]:col-span-8 min-[1440px]:grid-cols-2`}>
          <section className={css.group} aria-label={copy.entry}>
            <h3 className={css.label}>{copy.entry}</h3>
            <div className={css.entry}>
              <figure className={css.code}>
                <figcaption className={css.codeCaption}>{copy.entryFile}</figcaption>
                <pre className={css.codePre} tabIndex={0}>{STILL_ENTRY}</pre>
              </figure>
              <p className={css.entryLine}>{copy.additionsNote}</p>
            </div>
          </section>
          <div className={css.side}>
            <section className={css.group} aria-label={words.versions}>
              <div className={css.head}><h3 className={css.label}>{words.versions}</h3></div>
              <div className={css.list}>
                <ol className={css.versions}>
                  <li className={css.version}>
                    <span className={css.versionTitle}>{words.version}<span className={css.current}>{words.current}</span></span>
                    <span className={css.versionLine}>{words.line}</span>
                  </li>
                </ol>
              </div>
            </section>
            <div className={css.notes}>
              <p className={css.note}>{copy.backStudio}</p>
              <p className={css.note}>{copy.backCovers}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
