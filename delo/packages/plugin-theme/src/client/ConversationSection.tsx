/**
 * The Conversation section: how much of the agent's work a chat shows, in two
 * cards. "Detail" holds a preset or Custom from tiles, a live preview, and a
 * control for each part; changing a part while a preset is chosen switches to
 * Custom, seeded with that preset's parts. "Folding" holds whether and how
 * finished turns fold. It writes upstream's `ui-chat` settings.
 */
import { useState } from 'react'
import type { CustomDisplay, StepGrouping } from '@deepseek-ai/dsh-client-ui-chat'
import { IconChevronDownOutlineRegular, Menu, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  DISPLAY_MODES, displayMode, GROUPINGS, partsOf, THINKING_CHOICES, WINDOW_LINES,
  type ChatDisplaySettings, type DisplayMode, type ThinkingChoice,
} from './conversation.ts'
import { ConversationPreview } from './ConversationPreview.tsx'
import css from './ConversationSection.module.css'
import { useFormWrites } from './form-writes.ts'
import { cardCss, ChoiceGroup, SettingHeading, SettingsCard } from '@delo/settings-controls'

/** What the section reads and writes. */
export interface ConversationInjected {
  /** Upstream's chat display settings. */
  readonly settings: ConfigForm<ChatDisplaySettings>
}

/** The props the section reads: its dictionary and its injected services. */
export type ConversationSectionProps = PropsLocale<'settings.deloConversation'> & InjectFace<ConversationInjected>

/** How many bars each mode's tile draws: more for a mode that shows more. */
const BARS: Readonly<Record<DisplayMode, number>> = { compact: 2, standard: 3, detailed: 4, verbose: 6, custom: 0 }

/**
 * Render the Conversation section.
 * @param props - the dictionary and the services.
 * @returns the section.
 */
export function ConversationSection({ t, settings }: ConversationSectionProps) {
  const { snapshot, disabled, failed, save } = useFormWrites(settings)
  const value = snapshot.value ?? {}
  const mode = displayMode(value.transcriptView)
  const parts = partsOf(mode, value.customDisplay)
  const timing = value.collapseTiming ?? 'completion'
  const replies = value.foldedReplies ?? 'all'
  // Upstream draws its reserved `rsvp` display as `preview`, so the select names it so.
  const thinking: ThinkingChoice = parts.thinking === 'rsvp' ? 'preview' : parts.thinking
  const [running, setRunning] = useState(false)
  const [thinkingOpen, setThinkingOpen] = useState(false)

  // A part changed on a preset becomes Custom, starting from that preset's parts.
  const setPart = <K extends keyof CustomDisplay>(key: K, next: CustomDisplay[K]): void => {
    save('customDisplay', { ...parts, [key]: next })
    if (mode !== 'custom') save('transcriptView', 'custom')
  }

  return (
    <div className={cardCss.stack}>
      <SettingsCard id="delo-conversation-detail" title={t('detail')} className={css.section}>
        <section className={cardCss.block} aria-labelledby="delo-conversation-mode">
          <SettingHeading id="delo-conversation-mode" title={t('mode')} lead={t('lead')} />
          <div className={css.modeTiles} role="radiogroup" aria-labelledby="delo-conversation-mode">
            {DISPLAY_MODES.map(choice => (
              <button key={choice} type="button" role="radio" aria-checked={mode === choice} className={css.modeTile}
                disabled={disabled} onClick={() => { if (mode !== choice) save('transcriptView', choice) }}>
                <span className={css.bars} aria-hidden="true">
                  {choice === 'custom'
                    ? <span className={css.sliders}><span /><span /><span /></span>
                    : Array.from({ length: BARS[choice] }, (_, index) => <span key={index} className={css.bar} />)}
                </span>
                <span className={css.modeName}>{t(`mode.${choice}`)}</span>
                <span className={css.modeLead}>{t(`mode.${choice}.lead`)}</span>
              </button>
            ))}
          </div>
          <div className={css.previewFrame}>
            <div className={css.previewBar}>
              <span className={css.previewLabel}>{t('preview')}</span>
              <ChoiceGroup<'finished' | 'running'>
                label={t('preview')}
                value={running ? 'running' : 'finished'}
                disabled={false}
                options={[{ value: 'finished', label: t('preview.finished') }, { value: 'running', label: t('preview.running') }]}
                onChange={(next) => { setRunning(next === 'running') }}
              />
            </div>
            <ConversationPreview t={t} parts={parts} foldedReplies={replies} running={running} />
          </div>
        </section>

        <section className={cardCss.block} aria-labelledby="delo-conversation-thinking">
          <div className={cardCss.row}>
            <SettingHeading id="delo-conversation-thinking" title={t('thinking')} lead={t('thinking.lead')} />
            <Menu
              open={thinkingOpen}
              onClose={() => { setThinkingOpen(false) }}
              items={THINKING_CHOICES.map(choice => ({ id: choice, label: t(`thinking.${choice}`) }))}
              selectedId={thinking}
              onSelect={(id) => {
                setThinkingOpen(false)
                // The menu's ids are THINKING_CHOICES.
                if (id !== thinking) setPart('thinking', id as ThinkingChoice)
              }}
              align="end"
              portal
              anchor={(
                <button
                  type="button"
                  id="delo-conversation-thinking-value"
                  className={css.select}
                  aria-haspopup="menu"
                  aria-expanded={thinkingOpen}
                  aria-labelledby="delo-conversation-thinking delo-conversation-thinking-value"
                  disabled={disabled}
                  onClick={() => { setThinkingOpen(open => !open) }}
                >
                  {t(`thinking.${thinking}`)}
                  <IconChevronDownOutlineRegular className={css.selectChevron} />
                </button>
              )}
            />
          </div>
          {parts.thinking === 'window' && (
            <div className={cardCss.row}>
              <SettingHeading title={t('window')} />
              <ChoiceGroup<string>
                label={t('window')}
                value={String(parts.thinkingWindowLines)}
                disabled={disabled}
                options={WINDOW_LINES.map(lines => ({ value: String(lines), label: t('window.lines', { n: lines }) }))}
                onChange={(next) => { setPart('thinkingWindowLines', Number(next)) }}
              />
            </div>
          )}
        </section>

        <section className={`${cardCss.block} ${cardCss.row}`} aria-labelledby="delo-conversation-grouping">
          <SettingHeading id="delo-conversation-grouping" title={t('grouping')} lead={t('grouping.lead')} />
          <ChoiceGroup<StepGrouping>
            label={t('grouping')}
            value={parts.stepGrouping}
            disabled={disabled}
            options={GROUPINGS.map(choice => ({ value: choice, label: t(`grouping.${choice}`) }))}
            onChange={(next) => { setPart('stepGrouping', next) }}
          />
        </section>

        <section className={`${cardCss.block} ${cardCss.row}`} aria-labelledby="delo-conversation-live">
          <SettingHeading id="delo-conversation-live" title={t('liveDetail')} lead={t('liveDetail.lead')} />
          <Switch checked={parts.liveProcessDetail} disabled={disabled} label={t('liveDetail')} onChange={(next) => { setPart('liveProcessDetail', next) }} />
        </section>

        <section className={`${cardCss.block} ${cardCss.row}`} aria-labelledby="delo-conversation-terminals">
          <SettingHeading id="delo-conversation-terminals" title={t('terminals')} lead={t('terminals.lead')} />
          <ChoiceGroup<'closed' | 'open'>
            label={t('terminals')}
            value={parts.openTerminalCards ? 'open' : 'closed'}
            disabled={disabled}
            options={[{ value: 'closed', label: t('terminals.closed') }, { value: 'open', label: t('terminals.open') }]}
            onChange={(next) => { setPart('openTerminalCards', next === 'open') }}
          />
        </section>
      </SettingsCard>

      <SettingsCard id="delo-conversation-folding" title={t('folding')} className={css.section}>
        <section className={`${cardCss.block} ${cardCss.row}`} aria-labelledby="delo-conversation-fold">
          <SettingHeading id="delo-conversation-fold" title={t('fold')} lead={t('fold.lead')} />
          <Switch checked={parts.foldCompletedTurns} disabled={disabled} label={t('fold')} onChange={(next) => { setPart('foldCompletedTurns', next) }} />
        </section>
        {parts.foldCompletedTurns && (
          <>
            <section className={`${cardCss.block} ${cardCss.row}`} aria-labelledby="delo-conversation-timing">
              <SettingHeading id="delo-conversation-timing" title={t('timing')} lead={t('timing.lead')} />
              <ChoiceGroup<'completion' | 'next-input'>
                label={t('timing')}
                value={timing}
                disabled={disabled}
                options={[{ value: 'completion', label: t('timing.completion') }, { value: 'next-input', label: t('timing.next-input') }]}
                onChange={(next) => { save('collapseTiming', next) }}
              />
            </section>
            <section className={`${cardCss.block} ${cardCss.row}`} aria-labelledby="delo-conversation-replies">
              <SettingHeading id="delo-conversation-replies" title={t('replies')} lead={t('replies.lead')} />
              <ChoiceGroup<'all' | 'final'>
                label={t('replies')}
                value={replies}
                disabled={disabled}
                options={[{ value: 'all', label: t('replies.all') }, { value: 'final', label: t('replies.final') }]}
                onChange={(next) => { save('foldedReplies', next) }}
              />
            </section>
          </>
        )}
      </SettingsCard>

      {failed && <p className={cardCss.failure} role="alert">{t('saveFailed')}</p>}
    </div>
  )
}
