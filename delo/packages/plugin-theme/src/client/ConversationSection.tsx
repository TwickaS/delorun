/**
 * Settings → Appearance → Conversation: how much of the agent's work a chat
 * shows. A preset or Custom from tiles, a live preview, and a control for each
 * part; changing a part while a preset is chosen switches to Custom, seeded
 * with that preset's parts. It writes upstream's `ui-chat` settings.
 */
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { CustomDisplay, StepGrouping } from '@deepseek-ai/dsh-client-ui-chat'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  DISPLAY_MODES, displayMode, GROUPINGS, partsOf, THINKING_CHOICES, WINDOW_LINES,
  type ChatDisplaySettings, type DisplayMode,
} from './conversation.ts'
import { ConversationPreview } from './ConversationPreview.tsx'
import { ChoiceGroup } from './ChoiceGroup.tsx'
import css from './ConversationSection.module.css'

/** What the section reads and writes. */
export interface ConversationInjected {
  /** Upstream's chat display settings. */
  readonly settings: ConfigForm<ChatDisplaySettings>
}

/** The props the section reads: its dictionary and its injected services. */
export type ConversationSectionProps = PropsLocale<'settings.deloConversation'> & InjectFace<ConversationInjected>

/** How many bars each mode's tile draws: more for a mode that shows more. */
const BARS: Readonly<Record<DisplayMode, number>> = { compact: 2, standard: 3, detailed: 4, verbose: 6, custom: 0 }

/** The name and help of one setting. */
function Heading({ id, title, lead }: { id?: string; title: string; lead?: string }) {
  return (
    <div className={css.heading}>
      <h3 id={id} className={css.title}>{title}</h3>
      {lead !== undefined && <p className={css.lead}>{lead}</p>}
    </div>
  )
}

/**
 * Render the Conversation section.
 * @param props - the dictionary and the services.
 * @returns the section.
 */
export function ConversationSection({ t, settings }: ConversationSectionProps) {
  // A stable subscribe function: a new one per render would resubscribe on every render.
  const subscribe = useCallback((listener: () => void) => settings.subscribe(listener), [settings])
  const snapshot = useSyncExternalStore(subscribe, () => settings.getSnapshot())
  const value = snapshot.value ?? {}
  const mode = displayMode(value.transcriptView)
  const parts = partsOf(mode, value.customDisplay)
  const timing = value.collapseTiming ?? 'completion'
  const replies = value.foldedReplies ?? 'all'
  const [running, setRunning] = useState(false)
  const [failed, setFailed] = useState(false)
  const disabled = !snapshot.writable

  const save = (field: keyof ChatDisplaySettings, next: unknown): void => {
    setFailed(false)
    void settings.set(field, next).then((ok) => { if (!ok) setFailed(true) }, () => { setFailed(true) })
  }
  // A part changed on a preset becomes Custom, starting from that preset's parts.
  const setPart = <K extends keyof CustomDisplay>(key: K, next: CustomDisplay[K]): void => {
    save('customDisplay', { ...parts, [key]: next })
    if (mode !== 'custom') save('transcriptView', 'custom')
  }

  return (
    <div className={css.section}>
      <section className={css.block} aria-labelledby="delo-conversation-mode">
        <Heading id="delo-conversation-mode" title={t('title')} lead={t('lead')} />
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

      <section className={css.block} aria-labelledby="delo-conversation-thinking">
        <Heading id="delo-conversation-thinking" title={t('thinking')} lead={t('thinking.lead')} />
        <div className={css.chips} role="radiogroup" aria-labelledby="delo-conversation-thinking">
          {THINKING_CHOICES.map(choice => (
            <button key={choice} type="button" role="radio" aria-checked={parts.thinking === choice} className={css.chip}
              disabled={disabled} onClick={() => { if (parts.thinking !== choice) setPart('thinking', choice) }}>
              {t(`thinking.${choice}`)}
            </button>
          ))}
        </div>
        {parts.thinking === 'window' && (
          <div className={css.row}>
            <Heading title={t('window')} />
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

      <section className={`${css.block} ${css.row}`} aria-labelledby="delo-conversation-grouping">
        <Heading id="delo-conversation-grouping" title={t('grouping')} lead={t('grouping.lead')} />
        <ChoiceGroup<StepGrouping>
          label={t('grouping')}
          value={parts.stepGrouping}
          disabled={disabled}
          options={GROUPINGS.map(choice => ({ value: choice, label: t(`grouping.${choice}`) }))}
          onChange={(next) => { setPart('stepGrouping', next) }}
        />
      </section>

      <section className={`${css.block} ${css.row}`} aria-labelledby="delo-conversation-live">
        <Heading id="delo-conversation-live" title={t('liveDetail')} lead={t('liveDetail.lead')} />
        <Switch checked={parts.liveProcessDetail} disabled={disabled} label={t('liveDetail')} onChange={(next) => { setPart('liveProcessDetail', next) }} />
      </section>

      <section className={`${css.block} ${css.row}`} aria-labelledby="delo-conversation-terminals">
        <Heading id="delo-conversation-terminals" title={t('terminals')} lead={t('terminals.lead')} />
        <ChoiceGroup<'closed' | 'open'>
          label={t('terminals')}
          value={parts.openTerminalCards ? 'open' : 'closed'}
          disabled={disabled}
          options={[{ value: 'closed', label: t('terminals.closed') }, { value: 'open', label: t('terminals.open') }]}
          onChange={(next) => { setPart('openTerminalCards', next === 'open') }}
        />
      </section>

      <section className={css.block} aria-labelledby="delo-conversation-fold">
        <div className={css.row}>
          <Heading id="delo-conversation-fold" title={t('fold')} lead={t('fold.lead')} />
          <Switch checked={parts.foldCompletedTurns} disabled={disabled} label={t('fold')} onChange={(next) => { setPart('foldCompletedTurns', next) }} />
        </div>
        {parts.foldCompletedTurns && (
          <>
            <div className={css.row}>
              <Heading title={t('timing')} />
              <ChoiceGroup<'completion' | 'next-input'>
                label={t('timing')}
                value={timing}
                disabled={disabled}
                options={[{ value: 'completion', label: t('timing.completion') }, { value: 'next-input', label: t('timing.next-input') }]}
                onChange={(next) => { save('collapseTiming', next) }}
              />
            </div>
            <div className={css.row}>
              <Heading title={t('replies')} />
              <ChoiceGroup<'all' | 'final'>
                label={t('replies')}
                value={replies}
                disabled={disabled}
                options={[{ value: 'all', label: t('replies.all') }, { value: 'final', label: t('replies.final') }]}
                onChange={(next) => { save('foldedReplies', next) }}
              />
            </div>
          </>
        )}
      </section>

      {failed && <p className={css.failure} role="alert">{t('saveFailed')}</p>}
    </div>
  )
}
