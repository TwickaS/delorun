/**
 * The Workspace step: where the first chat opens. The default workspace when Delorun has one, or a workspace the
 * person chooses or makes in the new-workspace dialog, which opens over the guide and covers a folder on this computer,
 * a new folder and a clone from Git.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Card } from '../ui/Card.tsx'
import { ChipGroup } from '@delorun/brand'
import { StateLine } from '../ui/StateLine.tsx'
import { Explain } from '../ui/Explain.tsx'
import type { Store, WorkspaceMode } from '../guide.ts'
import type { StepProps } from './shared.ts'
import type { StartTarget, StepServices } from '../types.ts'
import css from './steps.module.css'

/**
 * @param store - a store.
 * @returns its current value, re-rendering on change.
 */
function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(useCallback(listener => store.subscribe(listener), [store]), () => store.getSnapshot())
}

/** The kinds of folder the default workspace's explanation gives as examples. */
const WORKSPACE_KINDS = ['code', 'files', 'empty'] as const

/**
 * The folder the first chat opens in, once one is chosen, with what it holds.
 * @param props - the services and the guide.
 * @returns the line, or nothing.
 */
function Chosen({ services, guide, focus = false }: StepProps & { readonly focus?: boolean }): ReactNode {
  const { t } = services
  const workspace = useStore(guide.workspace)
  if (workspace?.kind !== 'added') return null
  return <FolderCard path={workspace.path} note={t(`workspace.kind.${workspace.folder}`)} t={t} focus={focus} />
}

/**
 * The chosen folder as a card: its name once, then its path, then a plain description of what it holds. It names no
 * state; the choice is the state.
 * @param props - the path, the description, an optional name for a folder without one, whether the card takes focus when it appears and this plugin's copy.
 * @returns the card.
 */
function FolderCard({ path, note, name: given, focus = false, t }: { readonly path: string; readonly note?: string; readonly name?: string; readonly focus?: boolean; readonly t: StepServices['t'] }): ReactNode {
  const name = given ?? path.split(/[\\/]/).filter(part => part !== '').pop() ?? path
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { if (focus) box.current?.focus({ preventScroll: true }) }, [focus])
  return (
    <div ref={box} tabIndex={-1} className={css.focusable}>
      <Card title={name} labels={{ more: t('more'), less: t('less') }}>
        <span className={css.path}>{path}</span>
        {note !== undefined && <span className={css.hint}>{note}</span>}
      </Card>
    </div>
  )
}

/**
 * A workspace made in the new-workspace dialog: the dialog opens over the guide from one button, and what it makes is the
 * chosen workspace. Where the profile has no such dialog, one line says a folder can be added later from the sidebar.
 * @param props - the services and the guide.
 * @returns the choice.
 */
function AnotherWorkspace({ services, guide }: StepProps): ReactNode {
  const { t, start } = services
  const open = start.openNewWorkspace
  const workspace = useStore(guide.workspace)
  const [opening, setOpening] = useState(false)
  // Set once the dialog makes a workspace, so the folder card takes focus when it appears.
  const [made, setMade] = useState(false)
  const choose = (openDialog: NonNullable<typeof open>): void => {
    setOpening(true)
    void openDialog().then((outcome) => {
      setOpening(false)
      switch (outcome.kind) {
        case 'cancelled': return
        case 'created':
          setMade(true)
          // The dialog's service answers the id as a plain string; the route's JSON validation is where it is trusted.
          guide.chooseWorkspace({ kind: 'added', workspaceId: outcome.workspaceId as WorkspaceId, path: outcome.path, folder: outcome.folder })
          return
        /* v8 ignore next 2 -- closed-union default only defends a future widening of NewWorkspaceOutcome */
        default: assertNever(outcome)
      }
    })
  }
  if (open === undefined) return <p className={css.hint}>{t('workspace.new.later')}</p>
  const chosen = workspace?.kind === 'added'
  return (
    <div className={css.stack}>
      <Chosen services={services} guide={guide} focus={made} />
      <Button variant={chosen ? 'ghost' : 'outline'} size="sm" className={`${css.alignStart} ${css.inline}`} disabled={opening} aria-busy={opening}
        onClick={() => { choose(open) }}>{t(chosen ? 'workspace.new.another' : 'workspace.new')}</Button>
      {!chosen && <p className={css.hint}>{t('workspace.new.note')}</p>}
    </div>
  )
}

/**
 * The Workspace step body.
 * @param props - the services, the guide and where the chat opens without a choice.
 * @returns the step body.
 */
export function WorkspaceStep({ services, guide, target, keepCurrent }: StepProps & { readonly target: StartTarget; readonly keepCurrent: boolean }): ReactNode {
  const { t } = services
  const mode = useStore(guide.mode)
  const workspace = useStore(guide.workspace)
  const shown: WorkspaceMode = mode === 'default' && target.kind !== 'default' ? 'another' : mode
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t('workspace.lead')}</p>
      {target.kind === 'checking' && <StateLine tone="loading">{t('start.lead.checking')}</StateLine>}
      {target.kind === 'none' && <StateLine tone="warning">{t('start.lead.none')}</StateLine>}
      {target.kind === 'other' && workspace === undefined && <StateLine tone="info">{t('workspace.other')}</StateLine>}
      <ChipGroup label={t('workspace.how')} value={shown} onChange={(next) => {
        guide.setMode(next)
        if (next === 'default' && target.kind === 'default') guide.chooseWorkspace({ kind: 'default', workspaceId: target.workspaceId, path: target.path })
      }} options={[
        ...target.kind === 'default' ? [{ value: 'default' as WorkspaceMode, label: t('workspace.mode.default') }] : [],
        { value: 'another' as WorkspaceMode, label: t('workspace.mode.another') },
      ]} />
      {shown === 'default' && target.kind === 'default' && (
        <>
          <FolderCard path={target.path} name={t('workspace.default')} note={t('workspace.default.note')} t={t} />
          <Explain heading={t('workspace.about')} cards={WORKSPACE_KINDS.map(kind => ({ key: kind, title: t(`workspace.about.${kind}.title`), text: t(`workspace.about.${kind}.text`), sample: t(`workspace.about.${kind}.sample`) }))} />
          {keepCurrent && workspace === undefined && (
            <>
              <p className={css.hint}>{t('workspace.keep')}</p>
              <Button variant="outline" size="sm" className={`${css.alignStart} ${css.inline}`}
                onClick={() => { guide.chooseWorkspace({ kind: 'default', workspaceId: target.workspaceId, path: target.path }) }}>{t('workspace.useDefault')}</Button>
            </>
          )}
        </>
      )}
      {shown === 'another' && <AnotherWorkspace services={services} guide={guide} />}
    </div>
  )
}

/**
 * Close a union the compiler has narrowed to nothing.
 * @param value - the value that cannot occur.
 * @returns never.
 * @throws always.
 */
/* v8 ignore next 3 -- reached only when a closed union widens without its switch */
function assertNever(value: never): never {
  throw new Error(`unhandled value ${JSON.stringify(value)}`)
}
