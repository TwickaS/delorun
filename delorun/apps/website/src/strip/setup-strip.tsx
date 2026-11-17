/**
 * The setup strip in "Make it yours": the page is a setup. The visitor changes the page's look with the studio's own
 * controls, sees the `delorun-theme` entry Delorun would write, sees the change listed as a setup version, and can go back
 * by name. The look lives in the root element's attributes through the same store the header's control uses, so the two
 * never disagree; a change made with either one writes the entry and adds a version, as it would in the studio. Nothing
 * is stored. With scripts off the strip shows a still of itself after choosing Ocean.
 *
 * @module website/strip/setup-strip
 */
import { useEffect, useId, useRef, useState, type PointerEvent } from 'react'
import { Button, ChipGroup, ChoiceGroup, CodeBlock, TileGroup } from '@brand'
import { getLook, setLook, useLook } from '@design/look-store.ts'
import { DEFAULT_LOOK, KNOWN_ACCENTS, KNOWN_CONTRASTS, KNOWN_DENSITIES, KNOWN_LOOKS, type AccentId, type ContrastId, type Look, type LookId } from '@design/looks.ts'
import { en as studio } from '../../../../packages/plugin-theme/src/client/locales.ts'
import { en as versionsCopy } from '../../../../packages/bundle-local/src/client/versions-locales.ts'
import { STRIP_COPY } from './copy.ts'
import { earlierLook, editedName, entryYaml, record, START, STOP_CONTRAST, versionRows, type EntryConfig, type StripState } from './model.ts'
import { differenceName, themeName } from './names.ts'
import { centreOf, spread, type Point } from './spread.ts'
import css from './strip.module.css'

/** How long after a pointer press a change still spreads from the pointer rather than from the focused control. */
const POINTER_WINDOW_MS = 1000

/** The scheme choices: the device's setting, or light or dark. */
type SchemeChoice = 'system' | 'light' | 'dark'

/**
 * Fills a template of the studio's versions dictionary.
 * @param template - the text with `{name}` style fields.
 * @param fields - the field values.
 * @returns the text.
 */
export function fill(template: string, fields: Readonly<Record<string, string>>): string {
  return template.replaceAll(/\{(\w+)\}/g, (whole, key: string) => fields[key] ?? whole)
}

/**
 * A theme tile's picture: the theme's page in light and in dark, each with a line of text and an accent pill. Each half
 * carries the look itself, so the looks stylesheet's `light-dark()` colours resolve in that half's own colour scheme.
 */
function Swatch({ look, accent }: { readonly look: LookId; readonly accent: AccentId }) {
  const custom = look === 'custom' ? accent : undefined
  return (
    <span className={css.swatch}>
      <span className={css.half} data-half="light" data-look={look} data-accent={custom}><span className={css.line} /><span className={css.pill} /></span>
      <span className={css.half} data-half="dark" data-look={look} data-accent={custom}><span className={css.line} /><span className={css.pill} /></span>
    </span>
  )
}

/** The entry Delorun would write, or the sentence that stands in for it before the first change. */
function Entry({ entry, changes }: { readonly entry: EntryConfig | undefined; readonly changes: number }) {
  if (entry === undefined) return <p className={css.empty}>{STRIP_COPY.entryEmpty}</p>
  // A new key per change seats the new entry.
  return <CodeBlock key={changes} className={css.seat} code={entryYaml(entry)} caption={STRIP_COPY.entryFile} copyLabel={STRIP_COPY.copyEntry} copiedLabel={STRIP_COPY.copied} failedLabel={STRIP_COPY.copyFailed} />
}

/** The setup versions, newest first, as the studio's Setup versions section titles and groups them; every change here has the same title, so they collapse into one row with a count. */
function Versions({ state }: { readonly state: StripState }) {
  const rows = versionRows(state.versions)
  if (rows.length === 0) return <p className={css.empty}>{STRIP_COPY.versionsEmpty}</p>
  const time = new Intl.DateTimeFormat(versionsCopy['time.locale'], { timeStyle: 'short' })
  const title = fill(versionsCopy['version.settings'], { name: editedName() })
  return (
    <ol className={css.versions}>
      {rows.map(({ version, count }) => (
        <li key={version.id} className={`${css.version} ${css.seat} ${css.later}`} data-current={version.current}>
          <span className={css.versionTitle}>
            {title}
            {version.current ? <span className={css.current}>{versionsCopy.current}</span> : null}
          </span>
          <span className={css.versionLine}>
            {time.format(version.at)} · {versionsCopy['origin.other']}{count > 1 ? ` · ${fill(versionsCopy['version.repeated'], { count: String(count) })}` : ''}
          </span>
        </li>
      ))}
    </ol>
  )
}

/**
 * The strip's controls, entry, versions and way back, drawn for a look and a strip state.
 * @param props.look - the look the controls show.
 * @param props.state - the entry and the versions.
 * @param props.onLook - called with the look a control asks for and the point the press came from; absent for the still.
 * @param props.announcement - what the live region says.
 * @returns the strip's contents.
 */
function StripBody({ look, state, onLook, announcement }: {
  readonly look: Look
  readonly state: StripState
  readonly onLook?: ((next: Look, from: Point | undefined) => void) | undefined
  readonly announcement?: { readonly text: string; readonly count: number } | undefined
}) {
  const themesId = useId()
  const pointer = useRef<{ readonly at: number; readonly point: Point } | undefined>(undefined)
  const customValues = useRef<{ accent: AccentId; contrast: ContrastId }>({ accent: DEFAULT_LOOK.accent, contrast: DEFAULT_LOOK.contrast })
  if (look.look === 'custom') customValues.current = { accent: look.accent, contrast: look.contrast }
  const custom = customValues.current
  const still = onLook === undefined
  const press = (next: Look): void => {
    const recent = pointer.current !== undefined && performance.now() - pointer.current.at < POINTER_WINDOW_MS
    const focused = document.activeElement
    onLook?.(next, recent ? pointer.current?.point : focused instanceof HTMLElement && focused !== document.body ? centreOf(focused) : undefined)
  }
  const toCustom = (values: Partial<Pick<Look, 'accent' | 'contrast'>>): void => {
    press({ ...look, look: 'custom', accent: custom.accent, contrast: custom.contrast, ...values })
  }
  const earlier = earlierLook(state)
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => { pointer.current = { at: performance.now(), point: { x: event.clientX, y: event.clientY } } }
  return (
    <div className={css.body}>
      <div className={css.controls} role="group" aria-label={STRIP_COPY.controls} onPointerDownCapture={onPointerDown} inert={still}>
        <div className={css.group}>
          <h3 id={themesId} className={css.label}>{studio.palette}</h3>
          <TileGroup labelledBy={themesId} className={css.tiles} value={look.look} disabled={false}
            onChange={(id) => { press(id === 'custom' ? { ...look, look: id, accent: custom.accent, contrast: custom.contrast } : { ...look, look: id, contrast: 'default' }) }}
            tiles={KNOWN_LOOKS.map(id => ({ value: id, label: studio[`palette.${id}`], preview: <Swatch look={id} accent={custom.accent} /> }))} />
        </div>
        <div className={css.group}>
          <span className={css.label} aria-hidden="true">{studio.mode}</span>
          <ChoiceGroup<SchemeChoice> label={studio.mode} value={look.scheme ?? 'system'} disabled={false} fill
            options={(['system', 'light', 'dark'] as const).map(value => ({ value, label: studio[`mode.${value}`] }))}
            onChange={(value) => { press({ ...look, scheme: value === 'system' ? undefined : value }) }} />
        </div>
        <div className={css.group}>
          <h3 className={css.label}>{studio['palette.custom']}</h3>
          <ChipGroup<AccentId | 'none'> label={studio.accent} variant="segmented" hideLabel value={look.look === 'custom' ? look.accent : 'none'}
            onChange={(accent) => { if (accent !== 'none') toCustom({ accent }) }}
            options={KNOWN_ACCENTS.map(accent => ({ value: accent, label: studio[`accent.${accent}`], mark: <span className={css.dot} data-look="custom" data-accent={accent} /> }))} />
          <ChoiceGroup<ContrastId> label={studio.contrast} value={look.look === 'custom' ? look.contrast : 'default'} disabled={false} fill
            options={KNOWN_CONTRASTS.map(stop => ({ value: stop, label: `${studio.contrast} ${String(STOP_CONTRAST[stop])}%` }))}
            onChange={(contrast) => { toCustom({ contrast }) }} />
        </div>
        <div className={css.group}>
          <span className={css.label} aria-hidden="true">{studio.density}</span>
          <ChoiceGroup label={studio.density} value={look.density} disabled={false} fill
            options={KNOWN_DENSITIES.map(density => ({ value: density, label: studio[`density.${density}`] }))}
            onChange={(density) => { press({ ...look, density }) }} />
        </div>
      </div>
      <div className={css.record}>
        <section className={css.group} aria-label={STRIP_COPY.entry}>
          <h3 className={css.label}>{STRIP_COPY.entry}</h3>
          <div className={css.entry}><Entry entry={state.entry} changes={state.versions.length} /></div>
        </section>
        <section className={css.group} aria-label={versionsCopy.title}>
          <div className={css.head}>
            <h3 className={css.label}>{versionsCopy.title}</h3>
            {earlier === undefined || still
              ? null
              : <Button variant="secondary" size="sm" onClick={() => { press({ ...earlier, scheme: look.scheme }) }}>{STRIP_COPY.back(differenceName(earlier, look))}</Button>}
          </div>
          <div className={css.list}><Versions state={state} /></div>
        </section>
        <div className={css.notes}>
          <p className={css.note}>{STRIP_COPY.backStudio}</p>
          <p className={css.note}>{STRIP_COPY.backCovers}</p>
        </div>
      </div>
      {/* A new key per change replaces the text, so the same sentence twice is announced twice. */}
      {still || announcement === undefined ? null : <p className={css.announce} role="status" aria-live="polite" data-strip-announce=""><span key={announcement.count}>{announcement.text}</span></p>}
    </div>
  )
}

/** The look of the still: Ocean, chosen once from a fresh studio. */
const STILL_LOOK: Look = { ...DEFAULT_LOOK, look: 'ocean' }

/** The strip's state in the still. */
const STILL_STATE: StripState = record(START, STILL_LOOK, Date.UTC(2026, 0, 1, 9, 0))

/**
 * The setup strip. The server draws it in its starting state, with a still of it after choosing Ocean for visitors
 * without scripts.
 * @returns the strip.
 */
export function SetupStrip() {
  const look = useLook()
  const [state, setState] = useState<StripState>(START)
  const [announcement, setAnnouncement] = useState({ text: '', count: 0 })
  // Every look the page shows, from the strip, the header or a link, is recorded as the studio would record it.
  useEffect(() => { setState(current => record(current, look, Date.now())) }, [look])
  const onLook = (next: Look, from: Point | undefined): void => {
    const before = getLook()
    spread(from, () => { setLook(next) })
    setAnnouncement(current => ({ text: STRIP_COPY.announce(differenceName(next, before)), count: current.count + 1 }))
  }
  return (
    <div className={css.strip} data-setup-strip="">
      <div className={css.live}><StripBody look={look} state={state} onLook={onLook} announcement={announcement} /></div>
      <noscript>
        <style>{`.${css.live}{visibility:hidden}`}</style>
        <div className={css.still} data-look={STILL_LOOK.look}>
          <p className={css.stillCaption}>{STRIP_COPY.still}</p>
          <StripBody look={STILL_LOOK} state={STILL_STATE} />
        </div>
      </noscript>
    </div>
  )
}

/** For tests: the still's look and state. */
export const STILL = { look: STILL_LOOK, state: STILL_STATE, name: themeName(STILL_LOOK) } as const
