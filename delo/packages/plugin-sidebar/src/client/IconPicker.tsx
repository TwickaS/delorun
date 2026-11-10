/**
 * The workspace icon picker: a dialog with the icon large and at the list's
 * own size, what it shows (letters, a glyph, an emoji or a generated
 * pattern), its colour from the named ones, the Workspace's own or any
 * colour, its shape and its style, a Surprise me that picks all of these at
 * random, and a reset to the Workspace's monogram.
 */
import { Button, Input, Modal, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useState } from 'react'
import {
  DEFAULT_WORKSPACE_ICON, ICON_COLORS, ICON_GLYPHS, ICON_KINDS, ICON_SHAPES, ICON_STYLES, isCustomColor, MAX_ICON_SEED, randomIcon,
  type WorkspaceIcon,
} from '../workspace-icon.ts'
import type { BadgeColor } from './sections.ts'
import { GLYPHS, WorkspaceBadge } from './WorkspaceBadge.tsx'
import css from './IconPicker.module.css'

/** The emoji the picker offers; any other can be typed. */
export const ICON_EMOJIS = [
  '🚀', '✨', '🔥', '🌱', '🌊', '⚡', '🎨', '🎯', '📦', '🧪', '🧠', '🤖', '🛠️', '🐛', '📚', '💡',
  '🌍', '🏠', '🎮', '🎵', '📷', '🛒', '💼', '🔒', '⭐', '❤️', '🍀', '🌙', '☕', '🦄', '🐙', '🍕',
] as const

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// The classes this module's stylesheet defines; the typings of CSS modules allow a missing key.
const DIALOG_CLASS = css.dialog as string
const SCROLL_CLASS = css.scroll as string
const LETTERS_CLASS = css.letters as string

/** How many patterns the pattern tab shows at once. */
const PATTERN_CHOICES = 12

/** The size in pixels of a glyph in the glyph grid. */
const GLYPH_CELL_SIZE = 18

/** The colour a fresh custom pick starts from. */
const CUSTOM_START = '#E5734A'

/** The Workspace the picker edits. */
export interface IconPickerTarget {
  readonly workspaceId: string
  readonly title: string
  readonly color: BadgeColor
  /** Its chosen icon, or undefined while it shows its monogram. */
  readonly icon: WorkspaceIcon | undefined
}

/** The picker's props. */
export type IconPickerProps = PropsLocale<'deloSidebar'> & {
  readonly target: IconPickerTarget
  /** Save the icon, or null to return to the monogram. */
  readonly onSave: (icon: WorkspaceIcon | null) => void
  readonly onClose: () => void
}

/**
 * Render the picker for one Workspace. It opens on the Workspace's stored icon, or on the default icon when it has none.
 * @param props.target - the Workspace to edit.
 * @param props.onSave - called with the edited icon on Save, or with null on Use initials, which saves without a confirmation.
 * @param props.onClose - called on Cancel, the close button, Escape and a click outside the dialog.
 * @param props.t - the sidebar dictionary's translate function.
 * @returns the dialog.
 */
export function IconPicker({ target, onSave, onClose, t }: IconPickerProps) {
  const [icon, setIcon] = useState<WorkspaceIcon>(target.icon ?? DEFAULT_WORKSPACE_ICON)
  const [patternBase, setPatternBase] = useState(icon.seed)
  const change = (fields: Partial<WorkspaceIcon>): void => { setIcon(previous => ({ ...previous, ...fields })) }
  const badge = (shown: WorkspaceIcon, size: number) => <WorkspaceBadge title={target.title} color={target.color} icon={shown} size={size} />
  // The last grapheme typed replaces the emoji; clearing the field keeps the current one.
  const typeEmoji = (value: string): void => {
    const last = Array.from(graphemes.segment(value)).at(-1)?.segment
    if (last !== undefined) change({ emoji: last })
  }
  const custom = isCustomColor(icon.color)
  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t('icon.close')}
      title={t('icon.title')}
      description={t('icon.lead', { workspace: target.title })}
      className={DIALOG_CLASS}
      contentClassName={SCROLL_CLASS}
      footer={(
        <>
          <Button variant="ghost" className={css.reset} onClick={() => { onSave(null) }}>{t('icon.reset')}</Button>
          <Button variant="outline" onClick={onClose}>{t('icon.cancel')}</Button>
          <Button variant="primary" onClick={() => { onSave(icon) }}>{t('icon.save')}</Button>
        </>
      )}
    >
      <div className={css.body}>
        <div className={css.stage}>
          <div className={css.hero}>{badge(icon, 72)}</div>
          <div className={css.inList} aria-hidden="true">
            {badge(icon, 16)}
            <span className={css.inListTitle}>{target.title}</span>
          </div>
          <Button variant="outline" onClick={() => { setIcon(randomIcon(Math.random, ICON_EMOJIS)) }}>{t('icon.surprise')}</Button>
        </div>

        <div className={css.controls}>
          <SegmentedControl id="delo-icon-kind" label={t('icon.kind')} value={icon.kind}
            options={ICON_KINDS.map(kind => ({ value: kind, label: t(`icon.kind.${kind}`) }))}
            onChange={(kind) => { change({ kind }) }} />

          {icon.kind === 'letters' && (
            <label className={css.field}>
              <span className={css.label}>{t('icon.letters')}</span>
              <Input className={LETTERS_CLASS} aria-label={t('icon.letters')} maxLength={3} value={icon.letters} placeholder={t('icon.letters.placeholder')}
                onChange={(event) => { change({ letters: event.currentTarget.value.slice(0, 3) }) }} />
            </label>
          )}
          {icon.kind === 'glyph' && (
            <div className={css.grid} role="radiogroup" aria-label={t('icon.kind.glyph')}>
              {ICON_GLYPHS.map((glyph) => {
                const Glyph = GLYPHS[glyph]
                return (
                  <button key={glyph} type="button" role="radio" aria-checked={icon.glyph === glyph} aria-label={t(`icon.glyph.${glyph}`)}
                    title={t(`icon.glyph.${glyph}`)} className={css.cell} onClick={() => { change({ glyph }) }}>
                    <Glyph size={GLYPH_CELL_SIZE} />
                  </button>
                )
              })}
            </div>
          )}
          {icon.kind === 'emoji' && (
            <>
              <div className={css.grid} role="radiogroup" aria-label={t('icon.kind.emoji')}>
                {ICON_EMOJIS.map(emoji => (
                  <button key={emoji} type="button" role="radio" aria-checked={icon.emoji === emoji} aria-label={emoji} className={`${css.cell} ${css.emojiCell}`}
                    onClick={() => { change({ emoji }) }}>
                    {emoji}
                  </button>
                ))}
              </div>
              <label className={css.field}>
                <span className={css.label}>{t('icon.emoji.other')}</span>
                <Input className={LETTERS_CLASS} aria-label={t('icon.emoji.other')} value={icon.emoji}
                  onChange={(event) => { typeEmoji(event.currentTarget.value) }} />
              </label>
            </>
          )}
          {icon.kind === 'pattern' && (
            <>
              <div className={css.grid} role="radiogroup" aria-label={t('icon.kind.pattern')}>
                {Array.from({ length: PATTERN_CHOICES }, (_, index) => (patternBase + index * 7_919) % MAX_ICON_SEED || 1).map(seed => (
                  <button key={seed} type="button" role="radio" aria-checked={icon.seed === seed} aria-label={t('icon.pattern', { n: String(seed) })}
                    className={css.cell} onClick={() => { change({ seed }) }}>
                    {badge({ ...icon, seed, shape: 'square', style: 'soft' }, 28)}
                  </button>
                ))}
              </div>
              <div>
                <Button variant="ghost" onClick={() => { setPatternBase(1 + Math.floor(Math.random() * (MAX_ICON_SEED - 1))) }}>{t('icon.pattern.more')}</Button>
              </div>
            </>
          )}

          <div className={css.field}>
            <span className={css.label}>{t('icon.color')}</span>
            <div className={css.swatches} role="radiogroup" aria-label={t('icon.color')}>
              {ICON_COLORS.map(color => (
                <button key={color} type="button" role="radio" aria-checked={icon.color === color} aria-label={t(`icon.color.${color}`)} title={t(`icon.color.${color}`)}
                  className={css.swatch} onClick={() => { change({ color }) }}>
                  {/* A solid circle: the single space keeps the Workspace's initials off it. */}
                  {badge({ ...DEFAULT_WORKSPACE_ICON, color, letters: ' ', shape: 'circle', style: 'solid' }, 22)}
                </button>
              ))}
              <label className={css.swatch} data-checked={custom} title={t('icon.color.custom')}>
                <input type="color" className={css.colorInput} aria-label={t('icon.color.custom')} value={custom ? icon.color : CUSTOM_START}
                  onChange={(event) => { change({ color: event.currentTarget.value.toUpperCase() }) }} />
              </label>
            </div>
          </div>

          <div className={css.field}>
            <span className={css.label}>{t('icon.shape')}</span>
            <div className={css.options} role="radiogroup" aria-label={t('icon.shape')}>
              {ICON_SHAPES.map(shape => (
                <button key={shape} type="button" role="radio" aria-checked={icon.shape === shape} aria-label={t(`icon.shape.${shape}`)}
                  className={css.option} onClick={() => { change({ shape }) }}>
                  <span aria-hidden="true" className={css.optionPreview}>{badge({ ...icon, shape }, 24)}</span>
                  <span aria-hidden="true">{t(`icon.shape.${shape}`)}</span>
                </button>
              ))}
            </div>
          </div>

          <div className={css.field}>
            <span className={css.label}>{t('icon.style')}</span>
            <div className={css.options} role="radiogroup" aria-label={t('icon.style')}>
              {ICON_STYLES.map(style => (
                <button key={style} type="button" role="radio" aria-checked={icon.style === style} aria-label={t(`icon.style.${style}`)}
                  className={css.option} onClick={() => { change({ style }) }}>
                  <span aria-hidden="true" className={css.optionPreview}>{badge({ ...icon, style }, 24)}</span>
                  <span aria-hidden="true">{t(`icon.style.${style}`)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}
