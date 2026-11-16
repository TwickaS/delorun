/**
 * An agent's Advanced options: stricter presets as plain outcomes, and a Fine-tune group with the model and the run
 * time limit. Closed by default; the default path never needs it. A choice made before the agent is added is kept and
 * written to the agent's row once the row exists.
 */
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { RUN_TIMEOUT_MINUTES } from '@delorun/plugin-delegation-consent/wire'
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { AgentModelsAnswer } from '../../wire.ts'
import type { AgentRowSettings, StepServices } from '../types.ts'
import { Disclosure } from '../ui/Disclosure.tsx'
import { AGENT_PRESETS, type AgentId } from './agent-presets.ts'
import css from './agents.module.css'

/**
 * @param form - a settings form.
 * @returns its current snapshot, re-rendering on change.
 */
function useForm<T>(form: ConfigForm<T>): ReturnType<ConfigForm<T>['getSnapshot']> {
  return useSyncExternalStore(useCallback(listener => form.subscribe(listener), [form]), () => form.getSnapshot())
}

/** What the person chose before the agent's row existed. */
interface Pending {
  readonly mode?: string
}

/** The props of the group. */
export interface AgentAdvancedProps {
  /** The agent's connection id. */
  readonly agent: AgentId
  /** The key of its copy. */
  readonly copy: 'claude' | 'codex'
  /** The agent's name. */
  readonly title: string
  /** The services. */
  readonly services: StepServices
}

/**
 * The Advanced options of one agent.
 * @param props - the agent, its copy key and name, and the services.
 * @returns the disclosure.
 */
/** The model choice: the agent's own default first, then the models the installed agent reports. */
function ModelChoice({ agent, form, live, services, title }: {
  readonly agent: AgentId
  readonly form: ConfigForm<AgentRowSettings>
  readonly live: boolean
  readonly services: StepServices
  readonly title: string
}): ReactNode {
  const { t } = services
  const row = useForm(form)
  const [answer, setAnswer] = useState<AgentModelsAnswer | 'reading' | undefined>()
  const name = useId()
  useEffect(() => {
    if (!live) { setAnswer(undefined); return undefined }
    let current = true
    setAnswer('reading')
    void services.host.agentModels(agent).then((next) => { if (current) setAnswer(next) })
    return () => { current = false }
  }, [live, agent, services.host])
  const saved = row.value?.model ?? ''
  const listed = typeof answer === 'object' && answer.state === 'listed' ? answer.models : []
  const options: readonly { readonly value: string; readonly label: string }[] = [
    { value: '', label: t('agents.model.default') },
    ...listed.map(each => ({ value: each.model, label: each.displayName })),
    // A model already configured that the agent does not list stays visible, so the choice never hides what is set.
    ...saved !== '' && !listed.some(each => each.model === saved) ? [{ value: saved, label: saved }] : [],
  ]
  const choose = (value: string): void => {
    if (!live) return
    void (value === '' ? form.unset('model') : form.set('model', value)).catch((error: unknown) => { console.warn('delorun onboarding: the agent model was not saved', error) })
  }
  const note = !live ? t('agents.model.later', { name: title }) : answer === 'reading' || answer === undefined ? t('agents.model.reading') : answer.state === 'unavailable' ? t('agents.model.unavailable') : undefined
  return (
    <div className={css.field}>
      <span className={css.fieldLabel} id={`${name}-label`}>{t('agents.model.label')}</span>
      <div role="radiogroup" aria-labelledby={`${name}-label`} className={css.models}>
        {options.map(option => (
          <label key={option.value} className={css.model} data-selected={option.value === saved ? '' : undefined}>
            <input type="radio" className={css.radio} name={name} value={option.value} checked={option.value === saved} disabled={!live || services.remote}
              onChange={() => { choose(option.value) }} />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {note !== undefined && <span className={css.hint} role="status">{note}</span>}
    </div>
  )
}

export function AgentAdvanced({ agent, copy, title, services }: AgentAdvancedProps): ReactNode {
  const { t, remote } = services
  const form = services.agents.rows[agent]
  const row = useForm(form)
  const limit = useForm(services.agents.limit)
  const [pending, setPending] = useState<Pending>({})
  const [minutesDraft, setMinutesDraft] = useState<string | undefined>()
  const name = useId()
  const presets = AGENT_PRESETS[agent]
  const live = row.status === 'ready' && row.value !== undefined && row.writable && !remote
  // Once the agent's row exists, what was chosen before it did is written and forgotten.
  useEffect(() => {
    if (!live || pending.mode === undefined) return
    const { mode } = pending
    setPending({})
    void form.set('permissionMode', mode).catch((error: unknown) => { console.warn('delorun onboarding: the agent preset was not saved', error) })
  }, [live, pending, form])
  const mode = pending.mode ?? row.value?.permissionMode ?? presets[0].mode
  const chosen = presets.find(each => each.mode === mode) ?? presets[0]
  const choose = (next: string): void => {
    if (live) void form.set('permissionMode', next).catch((error: unknown) => { console.warn('delorun onboarding: the agent preset was not saved', error) })
    else setPending({ ...pending, mode: next })
  }
  const savedMinutes = limit.value?.runTimeoutMinutes
  const commitMinutes = (): void => {
    const minutes = Number(minutesDraft)
    setMinutesDraft(undefined)
    if (Number.isInteger(minutes) && minutes >= RUN_TIMEOUT_MINUTES.min && minutes <= RUN_TIMEOUT_MINUTES.max && minutes !== savedMinutes) {
      void services.agents.limit.set('runTimeoutMinutes', minutes).catch((error: unknown) => { console.warn('delorun onboarding: the time limit was not saved', error) })
    }
  }
  const limitLive = limit.status === 'ready' && limit.writable && !remote
  const waiting = !live && pending.mode !== undefined
  return (
    <Disclosure label={t('agents.advanced')}>
      <div role="radiogroup" aria-label={t('agents.presets.label', { name: title })} className={css.presets}>
        {presets.map(preset => (
          <label key={preset.id} className={css.preset} data-selected={preset.id === chosen.id ? '' : undefined}>
            <input type="radio" className={css.radio} name={name} value={preset.mode} checked={preset.id === chosen.id} disabled={remote}
              onChange={() => { choose(preset.mode) }} />
            <span className={css.presetTitle}>{t(`agents.preset.${preset.id}`)}</span>
            <span className={css.presetText}>{t(`agents.${copy}.preset.${preset.id}.desc`)}</span>
          </label>
        ))}
      </div>
      <p className={css.changes} aria-live="polite">
        <span className={css.changesLabel}>{t('agents.preset.changes')}</span>{' '}
        {t(`agents.${copy}.preset.${chosen.id}.sets`)}{waiting ? ` ${t('agents.preset.pending', { name: title })}` : ''}
      </p>
      <Disclosure label={t('agents.fineTune')} size="quiet">
        <ModelChoice agent={agent} form={form} live={live} services={services} title={title} />
        {savedMinutes !== undefined && (
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor={`${name}-limit`}>{t('agents.limit.label')}</label>
            <Input id={`${name}-limit`} type="number" inputMode="numeric" min={RUN_TIMEOUT_MINUTES.min} max={RUN_TIMEOUT_MINUTES.max} step={1}
              value={minutesDraft ?? String(savedMinutes)} disabled={!limitLive}
              onChange={(event) => { setMinutesDraft(event.currentTarget.value) }}
              onBlur={commitMinutes} onKeyDown={(event) => { if (event.key === 'Enter') commitMinutes() }} />
            <span className={css.hint}>{t('agents.limit.hint', { min: String(RUN_TIMEOUT_MINUTES.min), max: String(RUN_TIMEOUT_MINUTES.max) })}</span>
          </div>
        )}
      </Disclosure>
    </Disclosure>
  )
}
