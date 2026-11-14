/**
 * Settings → Sidebar, in two headed groups. Header: the header art as preview
 * tiles drawn in the chosen palette, the palette swatches, the art's strength
 * and style as radio segments, and its fade as tiles. Chat list: the list's
 * style and sort order as radio segments, the Working shelf, Ask before
 * unpinning and the sidebar's width on a notched slider.
 * @module @delorun/plugin-sidebar/client/SettingsSection
 */
import { Button, Switch, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { ChoiceGroup, SettingHeading, SettingsCard } from '@delorun/settings-controls'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useId, useLayoutEffect, useState, useSyncExternalStore, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import {
  ART_FADES, ART_PALETTES, ART_STRENGTHS, ART_STYLES, DEFAULT_SIDEBAR_SETTINGS, HEADER_ARTS, LIST_VIEWS, MAX_ART_SEED, SIDEBAR_WIDTH, SORT_ORDERS,
  type ArtPalette, type SidebarSettings,
} from '../config.ts'
import { InkEdgeFilters, StageBackdrop } from './StageArt.tsx'
import { GENERATIVE_SCENES } from './GenerativeArt.tsx'
import css from './SettingsSection.module.css'

/** The scenes Shuffle redraws. */
const GENERATIVE: ReadonlySet<string> = new Set(GENERATIVE_SCENES)

/** What the section reads and writes. */
export interface SidebarSettingsInjected {
  /** The sidebar's settings, stored by the host half. */
  readonly settings: ConfigForm<SidebarSettings>
}

/** The section's props. */
export type SidebarSettingsProps = PropsLocale<'delorunSidebar'> & InjectFace<SidebarSettingsInjected>

/** A palette's swatch: the blueprint drawn in it, cropped to a circle. */
function swatch(palette: ArtPalette) {
  return (
    <span className={css.swatchArt} aria-hidden="true">
      <StageBackdrop scene="blueprint" palette={palette} compact fade={false} />
    </span>
  )
}

/**
 * A row of choices that scrolls sideways, as on a phone, with a bar under it that shows how much of the row is in
 * view and where: drag its thumb, or press the bar, to move along. The row's edges fade where more choices wait.
 * @param props - the group's accessible name, and the choices.
 * @returns the strip.
 */
function SwipeStrip({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  const [row, setRow] = useState<HTMLDivElement | null>(null)
  const [view, setView] = useState({ start: 0, size: 1 })
  const measure = useCallback(() => {
    if (row === null || row.scrollWidth === 0) return
    setView({ start: row.scrollLeft / row.scrollWidth, size: Math.min(1, row.clientWidth / row.scrollWidth) })
  }, [row])
  useLayoutEffect(() => {
    measure()
    if (row === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => { observer.disconnect() }
  }, [measure, row])
  const press = (event: PointerEvent<HTMLDivElement>): void => {
    const target = event.currentTarget
    const track = target.getBoundingClientRect()
    if (row === null || track.width === 0) return
    const grab = event.target instanceof HTMLElement && event.target.dataset.thumb !== undefined
      ? (event.clientX - track.left) / track.width - view.start
      : view.size / 2
    // Moving along the bar moves the row by the same share of its width.
    const follow = (clientX: number): void => { row.scrollLeft = ((clientX - track.left) / track.width - grab) * row.scrollWidth }
    follow(event.clientX)
    target.setPointerCapture(event.pointerId)
    const move = (moved: globalThis.PointerEvent): void => { follow(moved.clientX) }
    const end = (): void => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', end)
      target.removeEventListener('pointercancel', end)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
  }
  const scrolls = view.size < 0.999
  return (
    <div className={css.strip}>
      <div ref={setRow} className={css.stripRow} role="radiogroup" aria-label={label} onScroll={measure}
        data-more-before={scrolls && view.start > 0.001} data-more-after={scrolls && view.start + view.size < 0.999}>
        {children}
      </div>
      {scrolls && (
        <div className={css.swipeBar} aria-hidden="true" onPointerDown={press}>
          <span className={css.swipeThumb} data-thumb="" style={{ left: `${String(view.start * 100)}%`, width: `${String(view.size * 100)}%` }} />
        </div>
      )}
    </div>
  )
}

/**
 * One setting: its title and lead, with its control beside them, wrapping below on a narrow card.
 * @param props - the heading's id, title and lead, the control, and whether the row is muted.
 * @returns the row.
 */
function SettingRow({ id, title, lead, muted, children }: {
  readonly id: string
  readonly title: string
  readonly lead: string
  readonly muted?: boolean
  readonly children: ReactNode
}) {
  return (
    <section className={css.block} aria-labelledby={id} data-muted={muted}>
      <div className={css.row}>
        <SettingHeading id={id} title={title} lead={lead} />
        {children}
      </div>
    </section>
  )
}

/**
 * The width slider: any width in the range, with notches that snap within a step and buttons that jump to them.
 * Dragging shows the width; the setting is saved when the slider is let go.
 * @param props - the saved width, whether it is disabled, the label, the value and notch formats and the save.
 * @returns the slider.
 */
function WidthSlider({ value, disabled, label, format, notchLabel, onCommit }: {
  readonly value: number
  readonly disabled: boolean
  readonly label: string
  readonly format: (px: number) => string
  readonly notchLabel: (px: number) => string
  readonly onCommit: (px: number) => void
}) {
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? value
  const at = (px: number): string => `${String(((px - SIDEBAR_WIDTH.min) / (SIDEBAR_WIDTH.max - SIDEBAR_WIDTH.min)) * 100)}%`
  const snap = (px: number): number => SIDEBAR_WIDTH.notches.find(notch => Math.abs(notch - px) <= SIDEBAR_WIDTH.step) ?? px
  const commit = (): void => {
    if (draft !== null && draft !== value) onCommit(draft)
    setDraft(null)
  }
  return (
    <div className={css.slider}>
      <span className={css.sliderValue} aria-hidden="true">{format(shown)}</span>
      <div className={css.sliderTrack}>
        <input type="range" aria-label={label} aria-valuetext={format(shown)} disabled={disabled}
          min={SIDEBAR_WIDTH.min} max={SIDEBAR_WIDTH.max} step={SIDEBAR_WIDTH.step} value={shown}
          onChange={(event) => { setDraft(snap(Number(event.currentTarget.value))) }}
          onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
        {SIDEBAR_WIDTH.notches.map(notch => (
          <button key={notch} type="button" className={css.notch} style={{ left: at(notch) }} disabled={disabled}
            aria-pressed={value === notch} onClick={() => { if (value !== notch) onCommit(notch) }}>
            {notchLabel(notch)}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Render the section.
 * @param props - the dictionary and the settings.
 * @returns the section.
 */
export function SidebarSettingsSection({ settings, t }: SidebarSettingsProps) {
  const snapshot = useSyncExternalStore(listener => settings.subscribe(listener), () => settings.getSnapshot())
  const current = snapshot.value ?? DEFAULT_SIDEBAR_SETTINGS
  const disabled = !snapshot.writable
  const [failed, setFailed] = useState(false)
  // The tiles' brand draws through edge filters of the section's own, so a preview never depends on the sidebar's art being mounted.
  const edgeId = useId()
  const edgeIds = { brand: `${edgeId}-brand`, control: `${edgeId}-control` }
  const edgedBrand: CSSProperties = { filter: `url("#${edgeIds.brand}")` }
  // A refused or rejected write shows the notice; the next write clears it.
  const attempt = (write: () => Promise<boolean>): void => {
    setFailed(false)
    void write().then((ok) => { if (!ok) setFailed(true) }, () => { setFailed(true) })
  }
  const save = <K extends keyof SidebarSettings>(field: K, value: SidebarSettings[K]): void => {
    attempt(() => settings.set(field, value))
  }
  return (
    <div className={css.section}>
      <InkEdgeFilters ids={edgeIds} />
      {failed && <Toast text={t('settings.failed')} onDone={() => { setFailed(false) }} />}
      <SettingsCard id="delorun-sidebar-header" title={t('settings.group.header')}>
        <section className={css.block} aria-labelledby="delorun-sidebar-art">
          <div className={css.row}>
            <SettingHeading id="delorun-sidebar-art" title={t('settings.art')} lead={t('settings.art.lead')} />
            <Button variant="outline" disabled={disabled || !GENERATIVE.has(current.headerArt)}
              onClick={() => { save('artSeed', 1 + Math.floor(Math.random() * (MAX_ART_SEED - 1))) }}>
              {t('settings.art.shuffle')}
            </Button>
          </div>
          <SwipeStrip label={t('settings.art')}>
            {HEADER_ARTS.map(art => (
              <button key={art} type="button" role="radio" aria-checked={current.headerArt === art} aria-label={t(`settings.art.${art}`)}
                className={css.tile} disabled={disabled}
                onClick={() => { if (current.headerArt !== art) save('headerArt', art) }}>
                <span className={css.preview}>
                  {art !== 'none' && <StageBackdrop scene={art} palette={current.artPalette} seed={current.artSeed} compact />}
                  <span className={css.previewBrand} style={art === 'none' ? undefined : edgedBrand}>{t('settings.preview.brand')}</span>
                  <span className={css.previewRows} aria-hidden="true"><span /><span /><span /></span>
                </span>
                <span className={css.tileFoot}>
                  <span className={css.tileLabel}>{t(`settings.art.${art}`)}</span>
                  <span className={css.radio} aria-hidden="true" />
                </span>
              </button>
            ))}
          </SwipeStrip>
        </section>

        <section className={css.block} aria-labelledby="delorun-sidebar-palette" data-muted={current.headerArt === 'none'}>
          <div className={css.row}>
            <SettingHeading id="delorun-sidebar-palette" title={t('settings.palette')} lead={t('settings.palette.lead')} />
            <div className={css.picker}>
              <span className={css.pickerName} aria-hidden="true">{t(`settings.palette.${current.artPalette}`)}</span>
              <div className={css.swatches} role="radiogroup" aria-label={t('settings.palette')}>
                {ART_PALETTES.map(palette => (
                  <button key={palette} type="button" role="radio" aria-checked={current.artPalette === palette}
                    aria-label={t(`settings.palette.${palette}`)} title={t(`settings.palette.${palette}`)} className={css.swatch} disabled={disabled}
                    onClick={() => { if (current.artPalette !== palette) save('artPalette', palette) }}>
                    {swatch(palette)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <SettingRow id="delorun-sidebar-strength" title={t('settings.strength')} lead={t('settings.strength.lead')} muted={current.headerArt === 'none'}>
          <ChoiceGroup label={t('settings.strength')} value={current.artStrength} disabled={disabled}
            options={ART_STRENGTHS.map(strength => ({ value: strength, label: t(`settings.strength.${strength}`) }))}
            onChange={(strength) => { save('artStrength', strength) }} />
        </SettingRow>

        <SettingRow id="delorun-sidebar-style" title={t('settings.style')} lead={t('settings.style.lead')} muted={current.headerArt === 'none'}>
          <ChoiceGroup label={t('settings.style')} value={current.artStyle} disabled={disabled}
            options={ART_STYLES.map(style => ({ value: style, label: t(`settings.style.${style}`) }))}
            onChange={(style) => { save('artStyle', style) }} />
        </SettingRow>

        <section className={css.block} aria-labelledby="delorun-sidebar-fade" data-muted={current.headerArt === 'none'}>
          <div className={css.row}>
            <SettingHeading id="delorun-sidebar-fade" title={t('settings.fade')} lead={t('settings.fade.lead')} />
          </div>
          <SwipeStrip label={t('settings.fade')}>
            {ART_FADES.map(fade => (
              <button key={fade} type="button" role="radio" aria-checked={current.artFade === fade} aria-label={t(`settings.fade.${fade}`)}
                className={css.tile} disabled={disabled}
                onClick={() => { if (current.artFade !== fade) save('artFade', fade) }}>
                <span className={css.preview}>
                  <StageBackdrop scene={current.headerArt === 'none' ? 'blueprint' : current.headerArt} palette={current.artPalette} seed={current.artSeed}
                    strength={current.artStrength} compact fade={fade} />
                  <span className={css.previewBrand} style={edgedBrand}>{t('settings.preview.brand')}</span>
                  <span className={css.previewRows} aria-hidden="true"><span /><span /><span /></span>
                </span>
                <span className={css.tileFoot}>
                  <span className={css.tileLabel}>{t(`settings.fade.${fade}`)}</span>
                  <span className={css.radio} aria-hidden="true" />
                </span>
              </button>
            ))}
          </SwipeStrip>
        </section>
      </SettingsCard>

      <SettingsCard id="delorun-sidebar-list" title={t('settings.group.list')}>
        <SettingRow id="delorun-sidebar-view" title={t('settings.view')} lead={t('settings.view.lead')}>
          <ChoiceGroup label={t('settings.view')} value={current.view} disabled={disabled}
            options={LIST_VIEWS.map(view => ({ value: view, label: t(`settings.view.${view}`) }))}
            onChange={(view) => { save('view', view) }} />
        </SettingRow>

        <SettingRow id="delorun-sidebar-sort" title={t('settings.sort')} lead={t('settings.sort.lead')}>
          <ChoiceGroup label={t('settings.sort')} value={current.sort} disabled={disabled}
            options={SORT_ORDERS.map(sort => ({ value: sort, label: t(`settings.sort.${sort}`) }))}
            onChange={(sort) => { save('sort', sort) }} />
        </SettingRow>

        <SettingRow id="delorun-sidebar-working" title={t('settings.working')} lead={t('settings.working.lead')}>
          <Switch checked={current.workingShelf} disabled={disabled} label={t('settings.working')}
            onChange={(checked) => { save('workingShelf', checked) }} />
        </SettingRow>

        <SettingRow id="delorun-sidebar-unpin" title={t('settings.confirmUnpin')} lead={t('settings.confirmUnpin.lead')}>
          <Switch checked={current.confirmUnpin} disabled={disabled} label={t('settings.confirmUnpin')}
            onChange={(checked) => { save('confirmUnpin', checked) }} />
        </SettingRow>

        <SettingRow id="delorun-sidebar-width" title={t('settings.width')} lead={t('settings.width.lead')}>
          <WidthSlider value={current.width} disabled={disabled} label={t('settings.width')}
            format={px => t('settings.width.value', { px: String(px) })} notchLabel={px => String(px)}
            onCommit={(px) => { save('width', px) }} />
        </SettingRow>

        <p className={css.credit}>{t('settings.credit')}</p>
      </SettingsCard>
    </div>
  )
}
