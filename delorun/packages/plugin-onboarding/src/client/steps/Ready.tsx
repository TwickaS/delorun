/**
 * Ready: what the guide set, line by line, and the starting prompts the first chat will offer in the chosen folder.
 */
import { useCallback, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { folderOf } from '../guide.ts'
import { STARTERS, starterSet } from '../StarterPrompts.tsx'
import type { ReachState, StartTarget } from '../types.ts'
import { AGENT_BUNDLES } from './Agents.tsx'
import { useStore, type StepProps, type Tone } from './shared.ts'
import css from './steps.module.css'

/** One line of the Ready checklist. */
interface CheckLine {
  readonly key: string
  readonly label: string
  readonly value: string
  readonly tone: Tone
}

/**
 * Ready: what the guide set, line by line, and the starting prompts the first chat will offer in the chosen folder.
 * @param props - the services, the guide, the reach state and where the chat opens without a choice.
 * @returns the step body.
 */
export function ReadyStep({ services, guide, reach, target }: StepProps & { readonly reach: ReachState; readonly target: StartTarget }): ReactNode {
  const { t, appearance, look, plugins, optionalRows, bundles } = services
  const keys = useStore(guide.keys)
  const workspace = useStore(guide.workspace)
  const settings = useSyncExternalStore(useCallback(listener => look.settings.subscribe(listener), [look]), () => look.settings.getSnapshot())
  const views = useSyncExternalStore(useCallback(listener => bundles.views.subscribe(listener), [bundles]), () => bundles.views.getSnapshot())
  const added = (name: string): boolean => views[name]?.state === 'installed' || views[name]?.state === 'restart'
  const working = keys.status === 'ready' ? keys.value.providers.filter(each => each.result === 'works') : []
  const palette = settings.value?.palette ?? 'soft'
  const agents = AGENT_BUNDLES.filter(each => added(each.name)).map(each => t(`agents.${each.key}.title`))
  const rowViews = useSyncExternalStore(useCallback(listener => bundles.rows.subscribe(listener), [bundles]), () => bundles.rows.getSnapshot())
  const extra = plugins.filter(added).length + optionalRows.filter(id => rowViews[id]?.state === 'installed' || rowViews[id]?.state === 'restart').length
  const lines: CheckLine[] = [
    working.length > 0
      ? { key: 'model', label: t('ready.model'), value: working.map(each => each.name).join(', '), tone: undefined }
      : { key: 'model', label: t('ready.model'), value: t('ready.model.none'), tone: 'attention' },
    { key: 'look', label: t('ready.look'), value: palette === 'soft' ? `${appearance('palette.soft')} · ${appearance(`accent.${settings.value?.accent ?? 'peach'}`)}` : appearance(`palette.${palette}`), tone: undefined },
    { key: 'agents', label: t('ready.agents'), value: agents.length === 0 ? t('ready.none') : agents.join(', '), tone: undefined },
    { key: 'plugins', label: t('ready.plugins'), value: extra === 0 ? t('ready.none') : t('ready.plugins.count', { count: String(extra) }), tone: undefined },
    ...reach === 'absent' ? [] : [{ key: 'reach', label: t('ready.reach'), value: t(reach === 'set-up' ? 'ready.reach.on' : 'ready.reach.off'), tone: undefined }],
    workspace !== undefined
      ? { key: 'workspace', label: t('ready.workspace'), value: workspace.path, tone: undefined }
      : target.kind === 'default'
        ? { key: 'workspace', label: t('ready.workspace'), value: target.path, tone: undefined }
        : target.kind === 'other'
          ? { key: 'workspace', label: t('ready.workspace'), value: t('ready.workspace.last'), tone: undefined }
          : { key: 'workspace', label: t('ready.workspace'), value: t('ready.workspace.none'), tone: 'attention' },
  ]
  const set = starterSet(folderOf(workspace) ?? '')
  return (
    <div className={css.stack}>
      <dl className={css.checklist}>
        {lines.map(line => (
          <div key={line.key} className={css.checkRow}>
            <dt>{line.label}</dt>
            <dd className={css.status} data-tone={line.tone}>{line.value}</dd>
          </div>
        ))}
      </dl>
      {(workspace !== undefined || target.kind === 'other') && (
        <div className={css.field}>
          <span className={css.label}>{t('ready.starters')}</span>
          <ul className={css.starterPreview}>
            {STARTERS.map(number => <li key={number}>{t(`starter.${set}.${number}.label`)}</li>)}
          </ul>
        </div>
      )}
      <p className={css.hint}>{t('start.later')}</p>
    </div>
  )
}
