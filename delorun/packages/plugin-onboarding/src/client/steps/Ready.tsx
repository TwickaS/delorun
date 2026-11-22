/**
 * Ready: what the guide set, line by line, and a few ideas to try in the chosen folder, each with a Copy button.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { folderOf } from '../guide.ts'
import { didNotPass } from '../key-status.ts'
import { STARTERS, starterSet } from '../ideas.ts'
import type { ReachState, StartTarget, StepServices } from '../types.ts'
import { BreakablePath } from '../ui/BreakablePath.tsx'
import { AGENT_BUNDLES } from './Agents.tsx'
import { folderName, useStore, type StepProps, type Tone } from './shared.ts'
import css from './steps.module.css'

/** One line of the Ready checklist. */
interface CheckLine {
  readonly key: string
  readonly label: string
  readonly value: string
  readonly tone: Tone
  /** The workspace's path, shown under its folder name. */
  readonly path?: string
}

/**
 * One idea: its title, its text and a button that copies the text. Nothing is written into the message box.
 * @param props - the dictionary lookup, the idea's title and its text.
 * @returns the row.
 */
function Idea({ t, label, prompt }: { readonly t: StepServices['t']; readonly label: string; readonly prompt: string }): ReactNode {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no')
  const copy = (): void => {
    navigator.clipboard.writeText(prompt).then(() => { setCopied('yes') }, () => { setCopied('failed') })
  }
  return (
    <li className={css.idea}>
      <span className={css.ideaText}>
        <span className={css.ideaLabel}>{label}</span>
        <span className={css.ideaPrompt}>{prompt}</span>
      </span>
      <Button variant="outline" size="sm" className={css.inline} aria-label={t('ready.ideas.copyNamed', { label })} onClick={copy}>
        {copied === 'yes' ? t('copy.done') : copied === 'failed' ? t('copy.failed') : t('copy')}
      </Button>
    </li>
  )
}

/**
 * Ready: what the guide set, line by line, and a few ideas to try in the chosen folder.
 * @param props - the services, the guide, the reach state, where the chat opens without a choice and whether this is the first open, which lists only the model and the workspace.
 * @returns the step body.
 */
export function ReadyStep({ services, guide, reach, target, keepCurrent, first }: StepProps & { readonly reach: ReachState; readonly target: StartTarget; readonly keepCurrent: boolean; readonly first: boolean }): ReactNode {
  const { t, appearance, look, scheme, plugins, optionalRows, bundles } = services
  const mode = useSyncExternalStore(useCallback(listener => scheme.subscribe(listener), [scheme]), () => scheme.get())
  const keys = useStore(guide.keys)
  const stock = useStore(guide.stock)
  const workspace = useStore(guide.workspace)
  const phone = useStore(guide.phone)
  const settings = useSyncExternalStore(useCallback(listener => look.settings.subscribe(listener), [look]), () => look.settings.getSnapshot())
  const views = useSyncExternalStore(useCallback(listener => bundles.views.subscribe(listener), [bundles]), () => bundles.views.getSnapshot())
  const added = (name: string): boolean => views[name]?.state === 'installed' || views[name]?.state === 'restart'
  // The same key state the Models summary reads: a key that is stored and was not refused counts; one the test could not check says so.
  const working = keys.status === 'ready' ? keys.value.providers.filter(each => each.result !== 'no-key' && !didNotPass(each.result)) : []
  const palette = settings.value?.palette ?? 'soft'
  const agents = AGENT_BUNDLES.filter(each => added(each.name)).map(each => t(`agents.${each.key}.title`))
  const rowViews = useSyncExternalStore(useCallback(listener => bundles.rows.subscribe(listener), [bundles]), () => bundles.rows.getSnapshot())
  const extra = plugins.filter(added).length + optionalRows.filter(id => rowViews[id]?.state === 'installed' || rowViews[id]?.state === 'restart').length
  const all: CheckLine[] = [
    working.length > 0
      ? { key: 'model', label: t('ready.model'), value: working.map(each => each.result === 'works' ? each.name : t('ready.model.unverified', { name: each.name })).join(', '), tone: undefined }
      : { key: 'model', label: t('ready.model'), value: t('ready.model.none'), tone: 'attention' },
    { key: 'look', label: t('ready.look'), value: [palette === 'custom' ? `${appearance('palette.custom')} · ${appearance(`accent.${settings.value?.accent ?? 'peach'}`)}` : appearance(`palette.${palette}`), appearance(`mode.${mode}`)].join(' · '), tone: undefined },
    { key: 'agents', label: t('ready.agents'), value: agents.length === 0 ? t('ready.none') : agents.join(', '), tone: undefined },
    { key: 'plugins', label: t('ready.plugins'), value: extra === 0 ? t('ready.none') : t('ready.plugins.count', { count: String(extra) }), tone: undefined },
    ...reach === 'absent' ? [] : [{ key: 'reach', label: t('ready.reach'), value: t(reach === 'set-up' || phone === 'on' ? 'ready.reach.on' : phone === 'done' ? 'ready.reach.check' : 'ready.reach.off'), tone: undefined }],
    workspace !== undefined
      ? { key: 'workspace', label: t('ready.workspace'), value: folderName(workspace.path), path: workspace.path, tone: undefined }
      : target.kind === 'default' && !keepCurrent
        ? { key: 'workspace', label: t('ready.workspace'), value: folderName(target.path), path: target.path, tone: undefined }
        : target.kind === 'other' || keepCurrent
          ? { key: 'workspace', label: t('ready.workspace'), value: t('ready.workspace.last'), tone: undefined }
          : { key: 'workspace', label: t('ready.workspace'), value: t('ready.workspace.none'), tone: 'attention' },
  ]
  // A first open sets only the model and the workspace; the rest is in Settings.
  const lines = first ? all.filter(line => line.key === 'model' || line.key === 'workspace') : all
  const set = starterSet(folderOf(workspace) ?? '')
  return (
    <div className={css.stack}>
      <dl className={css.checklist}>
        {lines.map(line => (
          <div key={line.key} className={css.checkRow}>
            <dt>{line.label}</dt>
            <dd className={css.status} data-tone={line.tone}>
              {line.value}
              {line.path !== undefined && <span className={css.checkPath}><BreakablePath path={line.path} /></span>}
            </dd>
          </div>
        ))}
      </dl>
      {(workspace !== undefined || target.kind === 'other' || keepCurrent) && (
        <div className={css.field}>
          <span className={css.label}>{t('ready.ideas')}</span>
          <ul className={css.ideas}>
            {STARTERS.map(number => <Idea key={number} t={t} label={t(`starter.${set}.${number}.label`)} prompt={t(`starter.${set}.${number}.prompt`)} />)}
          </ul>
        </div>
      )}
      {stock && <p className={css.hint} role="status">{t('ready.stock')}</p>}
      <p className={`${css.hint} ${css.closing}`}>{t(first ? 'ready.more' : 'start.later')}</p>
    </div>
  )
}
