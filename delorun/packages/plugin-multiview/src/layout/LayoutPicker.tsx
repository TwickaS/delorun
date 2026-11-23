/**
 * The layout picker: the layout choices as thumbnails with their names, the current one marked, for the agents list and the
 * Multiview icon's menu. Choosing one shows it in the chat and makes it the default for new Multiviews; with Main and stack
 * chosen, its side and stack style follow underneath.
 * @module @delorun/plugin-multiview/layout/LayoutPicker
 */

import { useCallback, useRef, useSyncExternalStore, type JSX, type KeyboardEvent } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MultiviewService } from '../client/contract.ts'
import { LAYOUT_CHOICES } from './choices.ts'
import { LayoutThumb } from './LayoutThumb.tsx'
import type { LayoutsLocaleKey } from './locales.ts'
import styles from './LayoutPicker.module.css'
import { MAIN_SIDES, STACK_STYLES, type LayoutChoiceId } from './presets.ts'

/** The props of {@link LayoutPicker}. */
export interface LayoutPickerProps {
  /** The chat whose Multiview the choice arranges. */
  readonly chat: SessionId
  /** The Multiview service. */
  readonly multiview: MultiviewService
  /** The layout copy: `ctx.locale.bind(LAYOUTS_NS)`. */
  readonly t: Translate<LayoutsLocaleKey>
  /** `row`: one compact strip for the agents list; `grid`: thumbnails with names beside them, for a menu. */
  readonly variant: 'row' | 'grid'
  /** Called after a choice, so a menu can close. */
  readonly onChosen?: (() => void) | undefined
}

const ROVING_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'])

/**
 * The picker.
 * @param props - the chat, the service, the copy and the variant.
 * @returns a radio group of the choices, with "Reset to Auto" when the default is not Auto.
 */
export function LayoutPicker(props: LayoutPickerProps): JSX.Element {
  const { chat, multiview, t, variant, onChosen } = props
  const state = useSyncExternalStore(listener => multiview.of(chat).subscribe(listener), () => multiview.of(chat).getSnapshot())
  const defaults = useSyncExternalStore(listener => multiview.defaults.subscribe(listener), () => multiview.defaultsOf(chat))
  const current = state.arrangement ?? multiview.arrangementOf(chat)
  const shape = state.shape ?? defaults.shape
  const panes = 1 + state.pins.length
  const thumbPanes = Math.min(6, Math.max(4, panes))
  const choices = LAYOUT_CHOICES.filter(choice => choice.id !== 'yours' || shape !== undefined)
  const checkedId: LayoutChoiceId | undefined = current === 'custom' ? undefined : current
  const focusId = checkedId ?? choices[0]!.id
  const group = useRef<HTMLDivElement | null>(null)

  const choose = useCallback((id: LayoutChoiceId) => {
    multiview.chooseLayout(chat, id)
    onChosen?.()
  }, [multiview, chat, onChosen])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!ROVING_KEYS.has(event.key)) return
    // The agents list navigates its rows with these keys on its container; inside the picker they move between choices.
    event.stopPropagation()
    event.preventDefault()
    const next = rovingTarget(event.currentTarget, event.target, event.key)
    if (next === undefined) return
    next.focus()
    const id = next.dataset.choice as LayoutChoiceId | undefined
    if (id !== undefined) multiview.chooseLayout(chat, id)
  }

  return (
    <div className={styles.picker} data-variant={variant}>
      <div className={styles.head}>
        <span className={styles.title} id={`multiview-layout-${chat}`}>{t('picker.label')}</span>
        {defaults.layout !== 'auto' || shape !== undefined
          ? <button type="button" className={styles.reset} onClick={() => { multiview.resetToAuto(chat); onChosen?.() }}>{t('picker.reset')}</button>
          : null}
      </div>
      <div ref={group} role="radiogroup" aria-labelledby={`multiview-layout-${chat}`} className={styles.choices} onKeyDown={onKeyDown}>
        {choices.map((choice) => {
          const checked = choice.id === checkedId
          const label = t(choice.labelKey)
          return (
            <button
              key={choice.id}
              type="button"
              role="radio"
              aria-checked={checked}
              data-checked={checked || undefined}
              data-choice={choice.id}
              data-unavailable={!choice.available(panes) || undefined}
              tabIndex={choice.id === focusId ? 0 : -1}
              className={styles.choice}
              title={`${label}: ${t(choice.hintKey)}`}
              onClick={() => { choose(choice.id) }}
            >
              <span className={styles.thumb}>
                <LayoutThumb choice={choice.id} n={thumbPanes} size={variant === 'row' ? 28 : 34} shape={shape} mainSide={defaults.mainSide} stackStyle={defaults.stackStyle} />
              </span>
              <span className={variant === 'row' ? styles.srOnly : styles.label}>{label}</span>
            </button>
          )
        })}
      </div>
      {variant === 'row' && <div className={styles.caption} aria-hidden="true">{checkedId === undefined ? t('choice.yours') : t(`choice.${checkedId}`)}</div>}
      {checkedId === 'main-stack' && (
        <div className={styles.options} role="group" aria-label={t('picker.options')}>
          <Segmented
            label={t('picker.side')}
            values={MAIN_SIDES}
            current={defaults.mainSide}
            name={value => t(`side.${value}`)}
            onChange={value => { multiview.setStackOptions({ mainSide: value }, chat) }}
          />
          <Segmented
            label={t('picker.stack')}
            values={STACK_STYLES}
            current={defaults.stackStyle}
            name={value => t(`stack.${value}`)}
            onChange={value => { multiview.setStackOptions({ stackStyle: value }, chat) }}
          />
        </div>
      )}
    </div>
  )
}

/** The radio a roving key moves to from `from` inside `group`, wrapping at the ends. */
function rovingTarget(group: HTMLElement, from: EventTarget, key: string): HTMLButtonElement | undefined {
  const radios = [...group.querySelectorAll<HTMLButtonElement>(':scope [role="radio"]')].filter(radio => radio.closest('[role="radiogroup"]') === group)
  const at = radios.findIndex(radio => radio === from)
  const step = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1
  const index = key === 'Home' ? 0 : key === 'End' ? radios.length - 1 : (Math.max(0, at) + step + radios.length) % radios.length
  return radios[index]
}

/** A small segmented control of a few named values: one tab stop, arrow keys move and choose. */
function Segmented<V extends string>({ label, values, current, name, onChange }: {
  readonly label: string
  readonly values: readonly V[]
  readonly current: V
  readonly name: (value: V) => string
  readonly onChange: (value: V) => void
}): JSX.Element {
  return (
    <div className={styles.segmentRow}>
      <span className={styles.segmentLabel}>{label}</span>
      <div
        className={styles.segments}
        role="radiogroup"
        aria-label={label}
        onKeyDown={(event) => {
          if (!ROVING_KEYS.has(event.key)) return
          event.stopPropagation()
          event.preventDefault()
          const next = rovingTarget(event.currentTarget, event.target, event.key)
          if (next === undefined) return
          next.focus()
          const value = values.find(candidate => candidate === next.dataset.value)
          if (value !== undefined) onChange(value)
        }}
      >
        {values.map(value => (
          <button
            key={value}
            type="button"
            role="radio"
            tabIndex={value === current ? 0 : -1}
            data-value={value}
            aria-checked={value === current}
            data-checked={value === current || undefined}
            className={styles.segment}
            onClick={() => { onChange(value) }}
          >
            {name(value)}
          </button>
        ))}
      </div>
    </div>
  )
}
