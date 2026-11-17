/**
 * An agent's Advanced options: the model, chosen from the list the added agent reports, and the run time limit per
 * task. Closed by default; the default path never needs it.
 */
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
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

/** How many times a model list is asked again while the agent has not registered, and how long to wait between. */
const NOT_RUNNING_RETRIES = 10
const NOT_RUNNING_RETRY_MS = 3000

/** The model choice: the agent's own default first, then the models the installed agent reports. */
function ModelChoice({ agent, form, live, added, services, title }: {
  readonly agent: AgentId
  readonly form: ConfigForm<AgentRowSettings>
  readonly live: boolean
  readonly added: boolean
  readonly services: StepServices
  readonly title: string
}): ReactNode {
  const { t } = services
  const row = useForm(form)
  const [answer, setAnswer] = useState<AgentModelsAnswer | 'reading' | undefined>()
  const [attempt, setAttempt] = useState(0)
  const name = useId()
  // The list comes from the added agent itself; it does not wait for the agent's settings row to be writable. An agent
  // that has not registered yet is asked again a few times.
  useEffect(() => {
    if (!added) { setAnswer(undefined); return undefined }
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = (left: number): void => {
      setAnswer('reading')
      void services.host.agentModels(agent).then((next) => {
        if (!current) return
        setAnswer(next)
        if (next.state === 'unavailable' && next.reason === 'not-running' && left > 0) timer = setTimeout(() => { ask(left - 1) }, NOT_RUNNING_RETRY_MS)
      })
    }
    ask(NOT_RUNNING_RETRIES)
    return () => { current = false; clearTimeout(timer) }
  }, [added, agent, services.host, attempt])
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
  const note = !added ? t('agents.model.later', { name: title })
    : answer === 'reading' || answer === undefined ? t('agents.model.reading')
      : answer.state === 'unavailable' ? t(`agents.model.${answer.reason === 'not-running' ? 'notRunning' : answer.reason}`, { name: title })
        : undefined
  const retry = typeof answer === 'object' && answer.state === 'unavailable'
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
      {retry && <Button variant="outline" size="sm" className={css.inline} onClick={() => { setAttempt(each => each + 1) }}>{t('agents.model.retry')}</Button>}
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
  /** Whether the agent is added; the model list is read only then. */
  readonly added: boolean
}

/**
 * The Advanced options of one agent.
 * @param props - the agent, its name and the services.
 * @returns the disclosure.
 */
export function AgentAdvanced({ agent, title, services, added }: AgentAdvancedProps): ReactNode {
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
      <ModelChoice agent={agent} form={form} live={live} added={added} services={services} title={title} />
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
