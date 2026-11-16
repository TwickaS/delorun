/**
 * An agent's Advanced options: the model, chosen from the list the added agent reports, and the run time limit per
 * task. Closed by default; the default path never needs it.
 */
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { RUN_TIMEOUT_MINUTES } from '@delorun/plugin-delegation-consent/wire'
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { AgentModelsAnswer } from '../../wire.ts'
import type { AgentRowSettings, StepServices } from '../types.ts'
import { Disclosure } from '../ui/Disclosure.tsx'
import type { AgentId } from './agent-rows.ts'
import css from './agents.module.css'

/**
 * @param form - a settings form.
 * @returns its current snapshot, re-rendering on change.
 */
function useForm<T>(form: ConfigForm<T>): ReturnType<ConfigForm<T>['getSnapshot']> {
  return useSyncExternalStore(useCallback(listener => form.subscribe(listener), [form]), () => form.getSnapshot())
}

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

/** The props of the group. */
export interface AgentAdvancedProps {
  /** The agent's connection id. */
  readonly agent: AgentId
  /** The agent's name. */
  readonly title: string
  /** The services. */
  readonly services: StepServices
}

/**
 * The Advanced options of one agent.
 * @param props - the agent, its name and the services.
 * @returns the disclosure.
 */
export function AgentAdvanced({ agent, title, services }: AgentAdvancedProps): ReactNode {
  const { t, remote } = services
  const form = services.agents.rows[agent]
  const row = useForm(form)
  const limit = useForm(services.agents.limit)
  const [minutesDraft, setMinutesDraft] = useState<string | undefined>()
  const name = useId()
  const live = row.status === 'ready' && row.value !== undefined && row.writable && !remote
  const savedMinutes = limit.value?.runTimeoutMinutes
  const commitMinutes = (): void => {
    const minutes = Number(minutesDraft)
    setMinutesDraft(undefined)
    if (Number.isInteger(minutes) && minutes >= RUN_TIMEOUT_MINUTES.min && minutes <= RUN_TIMEOUT_MINUTES.max && minutes !== savedMinutes) {
      void services.agents.limit.set('runTimeoutMinutes', minutes).catch((error: unknown) => { console.warn('delorun onboarding: the time limit was not saved', error) })
    }
  }
  const limitLive = limit.status === 'ready' && limit.writable && !remote
  return (
    <Disclosure label={t('agents.advanced')}>
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
  )
}
