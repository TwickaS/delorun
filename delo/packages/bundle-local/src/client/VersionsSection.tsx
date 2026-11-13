/**
 * The Setup versions settings section: the profile history's versions, newest first with the current one marked, what
 * switching to each would change, Save this setup, and Switch to this version. Any signed-in studio reads the list and the
 * differences; saving and switching are offered only in the studio at the home's own computer, and the home refuses them
 * elsewhere, which the section also says in place.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { failureSentence, LOOPBACK_REQUIRED, type HostFetch, type Loaded } from './host-api.ts'
import {
  readSetupChanges, readSetupVersions, saveSetupVersion, switchSetupVersion,
  type VersionChanges, type VersionEntry, type VersionsAnswer,
} from './versions-api.ts'
import css from './VersionsSection.module.css'

/** What the plugin supplies the section. */
export interface VersionsSectionInjected {
  /** Sends the section's same-origin requests: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
  /** Whether this studio runs on the home's own computer, where saving and switching are offered. */
  atComputer: () => boolean
}

/** Props the renderer binds for the section. */
export type VersionsSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'deloVersions'> & InjectFace<VersionsSectionInjected>

type Translate = VersionsSectionProps['t']

/**
 * The sentence for a failed request.
 * @param t - the section's copy.
 * @param error - the caught error.
 * @returns the localized `LOOPBACK_REQUIRED` sentence, the Host's own sentence for another refusal, or the localized
 *   sentence for an unreachable Host or an unreadable answer.
 */
export function versionsFailureText(t: Translate, error: unknown): string {
  return failureSentence(error, {
    refused: (code, message) => code === LOOPBACK_REQUIRED ? t('loopback') : message,
    unreachable: t('failed.unreachable'),
    unreadable: t('failed.unreadable'),
  })
}

/**
 * What switching to a version changes, one plain sentence each.
 * @param t - the section's copy.
 * @param changes - the comparison.
 * @returns the sentences; empty when nothing changes.
 */
export function changeSentences(t: Translate, changes: VersionChanges): string[] {
  const decision = (value: boolean | 'pending' | undefined): string =>
    t(value === undefined ? 'build.unset' : value === 'pending' ? 'build.undecided' : value ? 'build.allowed' : 'build.denied')
  return [
    ...changes.plugins.map((plugin) => {
      if (plugin.from === undefined) return t('change.plugin.added', { name: plugin.name, to: plugin.to ?? '' })
      if (plugin.to === undefined) return t('change.plugin.removed', { name: plugin.name, from: plugin.from })
      return t('change.plugin.version', { name: plugin.name, from: plugin.from, to: plugin.to })
    }),
    ...changes.bundles.map(bundle => t(bundle.selected ? 'change.bundle.added' : 'change.bundle.removed', { name: bundle.name })),
    ...changes.patchChanged ? [t('change.patch')] : [],
    ...changes.homePatchChanged ? [t('change.homePatch')] : [],
    ...changes.exemptions.map(exemption => t(exemption.change === 'added' ? 'change.exemption.added' : 'change.exemption.removed', { key: exemption.key, axis: exemption.axis })),
    ...changes.builds.map(build => t('change.build', { key: build.key, from: decision(build.from), to: decision(build.to) })),
    ...changes.lockfileChanged ? [t('change.lockfile')] : [],
    ...changes.disabled.map(plugin => t('change.disabled', { name: plugin.name, message: plugin.message })),
  ]
}

/**
 * Render the section.
 * @param props - the section's copy, the request function and where the studio runs.
 * @returns the section.
 */
export function VersionsSection({ t, fetch, atComputer }: VersionsSectionProps): ReactNode {
  const [list, setList] = useState<Loaded<VersionsAnswer>>({ kind: 'loading' })
  const [notice, setNotice] = useState<string | undefined>()
  const computer = atComputer()
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setList({ kind: 'ready', value: await readSetupVersions(fetch) })
    } catch (error) {
      setList({ kind: 'failed', text: versionsFailureText(t, error) })
    }
  }, [fetch, t])
  useEffect(() => { void refresh() }, [refresh])
  return <div className={css.section}>
    <h2 className={css.heading}>{t('title')}</h2>
    <p className={css.intro}>{t('intro')}</p>
    {computer ? null : <p className={css.line} data-versions-away>{t('atComputer')}</p>}
    {computer ? <SaveSetup t={t} fetch={fetch} onSaved={async (text) => { setNotice(text); await refresh() }} /> : null}
    {notice === undefined ? null : <p className={css.notice} role="status">{notice}</p>}
    {list.kind === 'loading' ? <p className={css.line}>{t('loading')}</p> : null}
    {list.kind === 'failed' ? <p className={css.failed} role="alert">{list.text}</p> : null}
    {list.kind === 'ready' ? <VersionList t={t} fetch={fetch} computer={computer} answer={list.value}
      onSwitched={async (text) => { setNotice(text); await refresh() }} /> : null}
  </div>
}

/**
 * The name field and Save this setup.
 * @param props - the copy, the request function and what runs after a save with the sentence to show.
 * @returns the form.
 */
function SaveSetup({ t, fetch, onSaved }: { t: Translate; fetch: HostFetch; onSaved: (text: string) => Promise<void> }): ReactNode {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const save = async (): Promise<void> => {
    setFailure(undefined)
    setBusy(true)
    try {
      const saved = await saveSetupVersion(fetch, name)
      setName('')
      await onSaved(t(saved.created ? 'save.saved' : 'save.unchanged'))
    } catch (error) {
      setFailure(versionsFailureText(t, error))
    } finally {
      setBusy(false)
    }
  }
  return <form className={css.save} onSubmit={(event) => { event.preventDefault(); void save() }}>
    <label className={css.saveLabel}>
      <span>{t('save.name')}</span>
      <Input value={name} maxLength={60} autoComplete="off" placeholder={t('save.placeholder')}
        onChange={(event) => { setName(event.target.value) }} />
    </label>
    <Button variant="primary" size="sm" type="submit" disabled={busy}>{t('save.action')}</Button>
    {failure === undefined ? null : <p className={css.failed} role="alert">{failure}</p>}
  </form>
}

/**
 * The versions, or the empty state, with the note that the setup has unsaved changes.
 * @param props - the copy, the request function, where the studio runs, the answer and what runs after a switch.
 * @returns the list.
 */
function VersionList({ t, fetch, computer, answer, onSwitched }: {
  t: Translate; fetch: HostFetch; computer: boolean; answer: VersionsAnswer; onSwitched: (text: string) => Promise<void>
}): ReactNode {
  if (answer.problem !== undefined) return <p className={css.failed} role="alert">{answer.problem}</p>
  if (answer.versions.length === 0) return <p className={css.line}>{t('empty')}</p>
  return <>
    {answer.unsaved ? <p className={css.line}>{t('unsaved')}</p> : null}
    <ul className={css.list}>
      {answer.versions.map(version => <VersionRow key={version.id} t={t} fetch={fetch} computer={computer} version={version} onSwitched={onSwitched} />)}
    </ul>
  </>
}

/**
 * The title of a version: the name the person gave, or the history's own summary.
 * @param t - the section's copy.
 * @param version - the version.
 * @returns the title.
 */
function titleOf(t: Translate, version: VersionEntry): string {
  if (version.origin === 'saved') return version.name ?? t('version.saved')
  return version.summary
}

/**
 * One version: title, time, what made it, What changes, and Switch to this version where the studio may switch.
 * @param props - the copy, the request function, where the studio runs, the version and what runs after a switch.
 * @returns the row.
 */
function VersionRow({ t, fetch, computer, version, onSwitched }: {
  t: Translate; fetch: HostFetch; computer: boolean; version: VersionEntry; onSwitched: (text: string) => Promise<void>
}): ReactNode {
  const [changes, setChanges] = useState<Loaded<VersionChanges> | undefined>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const toggle = async (): Promise<void> => {
    if (changes !== undefined) {
      setChanges(undefined)
      return
    }
    setChanges({ kind: 'loading' })
    try {
      setChanges({ kind: 'ready', value: await readSetupChanges(fetch, version.id) })
    } catch (error) {
      setChanges({ kind: 'failed', text: versionsFailureText(t, error) })
    }
  }
  const switchTo = async (): Promise<void> => {
    setFailure(undefined)
    setBusy(true)
    try {
      const switched = await switchSetupVersion(fetch, version.id)
      await onSwitched(t(switched.restartNeeded ? 'switch.done' : 'switch.doneSame'))
    } catch (error) {
      setFailure(versionsFailureText(t, error))
    } finally {
      setBusy(false)
    }
  }
  const time = new Intl.DateTimeFormat(t('time.locale'), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(version.at))
  return <li className={css.row} data-version={version.id} data-current={version.current}>
    <div className={css.head}>
      <div className={css.details}>
        <div className={css.title}>{titleOf(t, version)}{version.current ? <span className={css.badge}>{t('current')}</span> : null}</div>
        <div className={css.description}>{time} · {t(`origin.${version.origin}`)}</div>
      </div>
      <div className={css.actions}>
        <Button variant="outline" size="sm" aria-expanded={changes !== undefined} onClick={() => { void toggle() }}>
          {t(changes === undefined ? 'changes.show' : 'changes.hide')}
        </Button>
        {version.current ? null : computer
          ? <Button variant="primary" size="sm" disabled={busy} onClick={() => { void switchTo() }}>{t(busy ? 'switch.busy' : 'switch.action')}</Button>
          : <span className={css.description}>{t('doAtComputer')}</span>}
      </div>
    </div>
    {changes === undefined ? null : <ChangesPanel t={t} changes={changes} />}
    {failure === undefined ? null : <p className={css.failed} role="alert">{failure}</p>}
  </li>
}

/**
 * What switching to one version changes.
 * @param props - the copy and the loaded comparison.
 * @returns the panel.
 */
function ChangesPanel({ t, changes }: { t: Translate; changes: Loaded<VersionChanges> }): ReactNode {
  if (changes.kind === 'loading') return <p className={css.description}>{t('changes.loading')}</p>
  if (changes.kind === 'failed') return <p className={css.failed} role="alert">{changes.text}</p>
  const sentences = changeSentences(t, changes.value)
  if (changes.value.same || sentences.length === 0) return <p className={css.description}>{t('changes.same')}</p>
  return <div className={css.changes}>
    <p className={css.description}>{t('changes.intro')}</p>
    <ul className={css.changeList}>{sentences.map(sentence => <li key={sentence}>{sentence}</li>)}</ul>
  </div>
}
