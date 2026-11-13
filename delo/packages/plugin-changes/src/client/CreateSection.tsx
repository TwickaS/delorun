/**
 * The Create a plugin section in Settings: a name, a kind and a workspace, then the files `delorun plugin new` would
 * write, created in the workspace's plugins folder. The result lists the files, opens the folder and asks for the plugin
 * to be turned on, which waits for the person's review in the Changes section. A page that is not at the computer says
 * so and offers no form.
 */
import { useEffect, useState } from 'react'
import { Button, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CREATE_KINDS, type CreatedView, type WorkspacesView } from '../wire.ts'
import type { ActionOutcome } from './controller.ts'
import css from './ChangesSection.module.css'

/** The controller's calls the section uses. */
export interface CreateSectionInjected {
  /**
   * Read where a plugin may be created.
   * @returns the workspaces, the default first, and whether the page is at the computer.
   */
  readonly workspaces: () => Promise<WorkspacesView>
  /**
   * Create a plugin.
   * @param name - the package name.
   * @param kind - the plugin kind.
   * @param workspace - the workspace's id.
   * @returns the created plugin, or the refusal's sentence.
   */
  readonly create: (name: string, kind: string, workspace: string) => Promise<CreatedView | { readonly refused: string }>
  /**
   * Ask for the plugin to be turned on.
   * @param name - the package name.
   * @param workspace - the workspace's id.
   * @returns the outcome.
   */
  readonly request: (name: string, workspace: string) => Promise<ActionOutcome>
  /**
   * Show the plugin's folder in the file manager.
   * @param name - the package name.
   * @param workspace - the workspace's id.
   * @returns the outcome.
   */
  readonly reveal: (name: string, workspace: string) => Promise<ActionOutcome>
}

/** Props the renderer binds for the section. */
export type CreateSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'deloChanges'> & InjectFace<CreateSectionInjected>

/** What the section read: nothing yet, a failed read, or the workspaces. */
type Load = { readonly status: 'loading' } | { readonly status: 'error' } | { readonly status: 'ready', readonly view: WorkspacesView }

/**
 * Render the section.
 * @param props - the dictionary and the controller's calls.
 * @returns the section.
 */
export function CreateSection(props: CreateSectionProps) {
  const { t, workspaces, create, request, reveal } = props
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [reads, setReads] = useState(0)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<string>(CREATE_KINDS[0])
  const [chosen, setChosen] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | undefined>()
  const [created, setCreated] = useState<CreatedView | undefined>()
  const [requested, setRequested] = useState(false)
  useEffect(() => {
    let current = true
    workspaces().then((view) => { if (current) setLoad({ status: 'ready', view }) }, (error: unknown) => {
      console.warn('delo-changes: the workspaces were not read:', error)
      if (current) setLoad({ status: 'error' })
    })
    return () => { current = false }
  }, [workspaces, reads])
  const view = load.status === 'ready' ? load.view : undefined
  const workspace = view?.workspaces.find(entry => entry.id === chosen) ?? view?.workspaces[0]
  const submit = (): void => {
    if (workspace === undefined) return
    setBusy(true)
    setRefusal(undefined)
    void create(name.trim(), kind, workspace.id).then((result) => {
      if ('refused' in result) setRefusal(result.refused)
      else setCreated(result)
    }).finally(() => { setBusy(false) })
  }
  return <div className={css.section} aria-busy={load.status === 'loading'}>
    <div className={css.header}>
      <h2 className={css.createHeading}>{t('create.title')}</h2>
    </div>
    <p className={css.meta}>{t('create.intro')}</p>
    {load.status === 'loading' ? <p className={css.meta} role="status">{t('create.loading')}</p> : null}
    {load.status === 'error'
      ? <div className={css.failure}>
        <p className={css.failureText} role="alert"><StateDot state="error" />{t('create.failed')}</p>
        <Button variant="outline" size="sm" onClick={() => { setLoad({ status: 'loading' }); setReads(read => read + 1) }}>{t('create.retry')}</Button>
      </div>
      : null}
    {view !== undefined && !view.atComputer
      ? <div className={css.remote} role="note" data-delo-create-remote><p className={css.meta}>{t('create.remote')}</p></div>
      : null}
    {view?.atComputer === true && workspace === undefined ? <p className={css.meta} role="note">{t('create.noWorkspace')}</p> : null}
    {view?.atComputer === true && workspace !== undefined && created === undefined
      ? <form className={css.group} onSubmit={(event) => { event.preventDefault(); submit() }}>
        <label className={css.groupHeading} htmlFor="delo-create-name">{t('create.name')}</label>
        <Input id="delo-create-name" value={name} placeholder={t('create.namePlaceholder')} autoComplete="off" spellCheck={false}
          onChange={(event) => { setName(event.target.value) }} />
        <p className={css.meta}>{t('create.nameHint')}</p>
        <label className={css.groupHeading} htmlFor="delo-create-kind">{t('create.kind')}</label>
        <select id="delo-create-kind" value={kind} onChange={(event) => { setKind(event.target.value) }}>
          {CREATE_KINDS.map(entry => <option key={entry} value={entry}>{t(`create.kind.${entry}`)}</option>)}
        </select>
        <label className={css.groupHeading} htmlFor="delo-create-workspace">{t('create.workspace')}</label>
        <select id="delo-create-workspace" value={workspace.id} onChange={(event) => { setChosen(event.target.value) }}>
          {view.workspaces.map(entry => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
        </select>
        <p className={css.meta} data-delo-create-where>{t('create.where', { folder: `${workspace.path}/plugins` })}</p>
        {refusal === undefined ? null : <p className={css.failureText} role="alert"><StateDot state="error" />{refusal === '' ? t('create.refusedUnknown') : t('create.refused', { message: refusal })}</p>}
        <div>
          <Button type="submit" variant="outline" size="sm" disabled={busy || name.trim() === ''}>{busy ? t('create.creating') : t('create.submit')}</Button>
        </div>
      </form>
      : null}
    {created === undefined ? null : <div className={css.group} data-delo-create-result>
      <p className={css.notice} role="status">{t('create.done', { plugin: created.plugin, folder: created.folder })}</p>
      <h3 className={css.groupHeading}>{t('create.files')}</h3>
      <ul className={css.rows}>{created.files.map(file => <li key={file} className={css.meta}>{file}</li>)}</ul>
      <p className={css.meta}>{requested ? t('create.requested') : t('create.off')}</p>
      <div className={css.metaRow}>
        <Button variant="outline" size="sm" onClick={() => { void reveal(created.plugin, created.workspace) }}>{t('create.open')}</Button>
        <Button variant="outline" size="sm" disabled={requested}
          onClick={() => { void request(created.plugin, created.workspace).then((outcome) => { if (outcome.kind === 'done') setRequested(true) }) }}>{t('create.enable')}</Button>
        <Button variant="outline" size="sm" onClick={() => { setCreated(undefined); setRequested(false); setName('') }}>{t('create.another')}</Button>
      </div>
    </div>}
  </div>
}
