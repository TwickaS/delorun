/**
 * Move your setup, in the Setup versions section: Export setup writes the profile's plugins, model choices and settings
 * as one signed file, and Import setup reads such a file, shows who signed it and everything an import would add, move,
 * remove or take back to its default, and replaces the setup only after a second click. The home checks the file and
 * applies it through the plugin requests that review a plugin's code; this component shows what the home answers.
 */
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SetupApplyView, SetupInspectView, SetupKeyView, SetupLeftOutView, SetupWasView } from '@delorun/plugin-changes/wire'
import { applySetupFile, exportSetupFile, fromBase64, inspectSetupFile, listSetupPlugins, replanSetupFile, type ExportChoices, type ImportChoices } from './setup-transfer-api.ts'
import { failureSentence, LOOPBACK_REQUIRED, type HostFetch } from './host-api.ts'
import type { VersionsSectionProps } from './VersionsSection.tsx'
import css from './VersionsSection.module.css'

type Translate = VersionsSectionProps['t']

/** Where the import stands. */
type Stage =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy', readonly text: string }
  | { readonly kind: 'exporting', readonly plugins: readonly { readonly name: string, readonly source: 'registry' | 'local' }[] }
  | { readonly kind: 'review', readonly view: SetupInspectView, readonly choices: ImportChoices }
  | { readonly kind: 'done', readonly view: SetupApplyView }

/**
 * The sentence for a failed request: the home's own sentence for a refusal, except the one only the home's computer may perform.
 * @param t - the section's copy.
 * @param error - the caught error.
 * @returns the sentence.
 */
function failureText(t: Translate, error: unknown): string {
  return failureSentence(error, {
    refused: (code, message) => code === LOOPBACK_REQUIRED ? t('loopback') : message,
    unreachable: t('failed.unreachable'),
    unreadable: t('failed.unreadable'),
  })
}

/**
 * Render Move your setup.
 * @param props - the section's copy, the request function and the function that hands a written file to the browser.
 * @returns the part of the section.
 */
export function SetupTransfer({ t, fetch, saveFile, onChanged }: {
  t: Translate
  fetch: HostFetch
  saveFile: (name: string, bytes: Uint8Array) => void
  onChanged: () => Promise<void>
}): ReactNode {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  const [notice, setNotice] = useState<string | undefined>()
  const [failure, setFailure] = useState<string | undefined>()
  const [leftOut, setLeftOut] = useState<readonly string[]>([])
  const input = useRef<HTMLInputElement>(null)
  const attempt = async (text: string, run: () => Promise<void>): Promise<void> => {
    setFailure(undefined)
    setNotice(undefined)
    setLeftOut([])
    setStage({ kind: 'busy', text })
    try {
      await run()
    } catch (error) {
      setStage({ kind: 'idle' })
      setFailure(failureText(t, error))
    }
  }
  const openExport = (): Promise<void> => attempt(t('transfer.listing'), async () => {
    setStage({ kind: 'exporting', plugins: (await listSetupPlugins(fetch)).plugins })
  })
  const exportFile = (choices: ExportChoices): Promise<void> => attempt(t('transfer.exporting'), async () => {
    const written = await exportSetupFile(fetch, choices)
    saveFile(written.name, fromBase64(written.file))
    setNotice(t('transfer.exported', { name: written.name, plugins: String(written.plugins), local: String(written.local), settings: String(written.settings), signedBy: written.signedBy }))
    setLeftOut([...written.withoutCode.length === 0 ? [] : [t('transfer.withoutCode', { names: written.withoutCode.join(', ') })], ...written.leftOut.map(item => leftOutSentence(t, item))])
    setStage({ kind: 'idle' })
  })
  const chosen = (file: File | undefined): Promise<void> => attempt(t('transfer.inspecting'), async () => {
    if (file === undefined) {
      setStage({ kind: 'idle' })
      return
    }
    setStage({ kind: 'review', view: await inspectSetupFile(fetch, new Uint8Array(await file.arrayBuffer()), DEFAULT_CHOICES), choices: DEFAULT_CHOICES })
  })
  const choose = async (view: SetupInspectView, choices: ImportChoices): Promise<void> => {
    setFailure(undefined)
    try {
      setStage({ kind: 'review', view: await replanSetupFile(fetch, view.token, choices), choices })
    } catch (error) {
      setStage({ kind: 'idle' })
      setFailure(failureText(t, error))
    }
  }
  const apply = (token: string, choices: ImportChoices): Promise<void> => attempt(t('transfer.applying'), async () => {
    setStage({ kind: 'done', view: await applySetupFile(fetch, token, choices) })
    await onChanged()
  })
  const busy = stage.kind === 'busy'
  return <div className={css.transfer}>
    <h3 className={css.reviewTitle}>{t('transfer.title')}</h3>
    <p className={css.line}>{t('transfer.intro')}</p>
    <div className={css.transferButtons}>
      <Button variant="outline" size="sm" disabled={busy || stage.kind === 'review' || stage.kind === 'exporting'} onClick={() => { void openExport() }}>{t('transfer.export')}</Button>
      <Button variant="outline" size="sm" disabled={busy || stage.kind === 'review' || stage.kind === 'exporting'} onClick={() => { input.current?.click() }}>{t('transfer.import')}</Button>
      <input ref={input} className={css.hiddenInput} type="file" accept=".delorun,application/zip" aria-label={t('transfer.import')} data-setup-file
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          void chosen(file)
        }} />
    </div>
    {stage.kind === 'busy' ? <p className={css.line} role="status">{stage.text}</p> : null}
    {notice === undefined ? null : <p className={css.notice} role="status">{notice}</p>}
    {leftOut.length === 0 ? null : <Lines title={t('transfer.leftOut')} lines={leftOut} />}
    {failure === undefined ? null : <p className={css.failed} role="alert">{failure}</p>}
    {stage.kind === 'exporting' ? <ExportForm t={t} plugins={stage.plugins} onWrite={(choices) => { void exportFile(choices) }} onCancel={() => { setStage({ kind: 'idle' }) }} /> : null}
    {stage.kind === 'review' ? <Review t={t} view={stage.view} choices={stage.choices} onChoose={(choices) => { void choose(stage.view, choices) }}
      onApply={() => { void apply(stage.view.token, stage.choices) }} onCancel={() => { setStage({ kind: 'idle' }) }} /> : null}
    {stage.kind === 'done' ? <Done t={t} view={stage.view} /> : null}
  </div>
}

/** An import replaces the settings and keeps the plugins the file does not list, until the person chooses otherwise. */
const DEFAULT_CHOICES: ImportChoices = { settings: true, removeOthers: false }

/**
 * A switch with its visible label.
 * @param props - the label, the state and what a click does.
 * @returns the row.
 */
function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }): ReactNode {
  return <div className={css.switchRow}>
    <Switch checked={checked} onChange={onChange} label={label} />
    <span>{label}</span>
  </div>
}

/**
 * The Export setup dialog: what goes in the file.
 * @param props - the copy, the plugins one could include and what the buttons do.
 * @returns the dialog.
 */
function ExportForm({ t, plugins, onWrite, onCancel }: {
  t: Translate
  plugins: readonly { readonly name: string, readonly source: 'registry' | 'local' }[]
  onWrite: (choices: ExportChoices) => void
  onCancel: () => void
}): ReactNode {
  const [settings, setSettings] = useState(true)
  const [localCode, setLocalCode] = useState(true)
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(plugins.map(plugin => plugin.name)))
  const [note, setNote] = useState('')
  const toggle = (name: string): void => {
    const next = new Set(chosen)
    if (!next.delete(name)) next.add(name)
    setChosen(next)
  }
  const write = (): void => {
    onWrite({ settings, localCode, ...chosen.size === plugins.length ? {} : { plugins: [...chosen] }, ...note.trim() === '' ? {} : { note: note.trim() } })
  }
  return <div className={css.review} data-setup-export-form>
    <h3 className={css.reviewTitle}>{t('transfer.export.title')}</h3>
    <SwitchRow label={t('transfer.settings.switch')} checked={settings} onChange={setSettings} />
    {plugins.some(plugin => plugin.source === 'local')
      ? <SwitchRow label={t('transfer.localCode')} checked={localCode} onChange={setLocalCode} />
      : null}
    {plugins.length === 0 ? null : <fieldset className={css.plugins}>
      <legend className={css.description}>{t('transfer.plugins')}</legend>
      {plugins.map(plugin => <label key={plugin.name} className={css.pluginRow}>
        <input type="checkbox" checked={chosen.has(plugin.name)} onChange={() => { toggle(plugin.name) }} />
        <span>{plugin.name}</span>
      </label>)}
    </fieldset>}
    <label className={css.saveLabel}>
      <span>{t('transfer.note')}</span>
      <Input value={note} maxLength={500} autoComplete="off" onChange={(event) => { setNote(event.target.value) }} />
    </label>
    <div className={css.transferButtons}>
      <Button variant="primary" size="sm" onClick={write}>{t('transfer.write')}</Button>
      <Button variant="outline" size="sm" onClick={onCancel}>{t('transfer.cancel')}</Button>
    </div>
  </div>
}

/**
 * A thing a setup leaves out, in the person's language.
 * @param t - the section's copy.
 * @param item - the home's code and subject.
 * @returns the sentence.
 */
function leftOutSentence(t: Translate, item: SetupLeftOutView): string {
  return t(`transfer.left.${item.code}`, { subject: item.subject })
}

/**
 * What the profile has now for a plugin, in the person's language.
 * @param t - the section's copy.
 * @param was - the home's code.
 * @returns the words.
 */
function wasSentence(t: Translate, was: SetupWasView): string {
  return t(`transfer.was.${was.kind}`, { version: 'version' in was ? was.version : '', spec: 'spec' in was ? was.spec : '' })
}

/**
 * A key to add, in the person's language.
 * @param t - the section's copy.
 * @param key - the home's code.
 * @returns the sentence.
 */
function keySentence(t: Translate, key: SetupKeyView): string {
  return key.kind === 'model'
    ? t('transfer.key.model', { provider: key.provider, model: key.model === undefined ? '' : ` / ${key.model}` })
    : t('transfer.key.variable', { name: key.name })
}

/**
 * A titled list.
 * @param props - the title and the lines.
 * @returns the list; nothing when there are no lines.
 */
function Lines({ title, lines }: { title: string; lines: readonly string[] }): ReactNode {
  if (lines.length === 0) return null
  return <div>
    <p className={css.description}>{title}</p>
    <ul className={css.changeList}>{lines.map(line => <li key={line}>{line}</li>)}</ul>
  </div>
}

/**
 * Who signed the inspected file, and everything importing it would change.
 * @param props - the copy, the inspection and what the two buttons do.
 * @returns the review.
 */
function Review({ t, view, choices, onChoose, onApply, onCancel }: {
  t: Translate; view: SetupInspectView; choices: ImportChoices; onChoose: (choices: ImportChoices) => void; onApply: () => void; onCancel: () => void
}): ReactNode {
  const signer = view.signer.state === 'verified'
    ? t('transfer.signer.verified', { fingerprint: view.signer.fingerprint })
    : view.signer.reason === 'absent' ? t('transfer.signer.absent') : t('transfer.signer.unknown', { fingerprint: view.signer.fingerprint })
  const installs = view.install.map(item => `${t(item.source === 'local' ? 'transfer.add.local' : 'transfer.add.registry', { name: item.name, version: item.version ?? '' })}${item.was === undefined ? '' : t('transfer.add.now', { from: wasSentence(t, item.was) })}`)
  return <div className={css.review} data-setup-review>
    <h3 className={css.reviewTitle}>{t('transfer.review.title')}</h3>
    <p className={view.signer.state === 'verified' ? css.line : css.warning}>{signer}</p>
    {view.note === undefined ? null : <p className={css.line}>{t('transfer.note.from', { note: view.note })}</p>}
    <p className={css.line}>{t('transfer.replaces', { parts: view.replaces.map(code => t(`transfer.replace.${code}`)).join('; ') })}</p>
    {view.includesSettings ? <SwitchRow label={t('transfer.settings.switch')} checked={choices.settings} onChange={(settings) => { onChoose({ ...choices, settings }) }} /> : null}
    <SwitchRow label={t('transfer.removeOthers')} checked={choices.removeOthers} onChange={(removeOthers) => { onChoose({ ...choices, removeOthers }) }} />
    <Lines title={t('transfer.named')} lines={view.named} />
    <Lines title={t('transfer.add')} lines={installs} />
    <Lines title={t('transfer.remove')} lines={view.remove} />
    <Lines title={t('transfer.settings')} lines={view.settingChanges.map(change => t(`transfer.change.${change.kind}`, { label: change.label }))} />
    <Lines title={t('transfer.endpoints')} lines={view.endpoints.map(endpoint => t('transfer.endpoint', endpoint))} />
    <Lines title={t('transfer.leftOutImport')} lines={view.leftOut.map(item => leftOutSentence(t, item))} />
    <p className={css.line}>{t(view.protection === 'on' ? 'transfer.protection.on' : 'transfer.protection.off')}</p>
    {view.changes ? null : <p className={css.line}>{t('transfer.nothing')}</p>}
    <div className={css.transferButtons}>
      {view.changes ? <Button variant="primary" size="sm" onClick={onApply}>{t('transfer.apply')}</Button> : null}
      <Button variant="outline" size="sm" onClick={onCancel}>{t('transfer.cancel')}</Button>
    </div>
  </div>
}

/**
 * What the import did, and what the person does next.
 * @param props - the copy and the home's answer.
 * @returns the summary.
 */
function Done({ t, view }: { t: Translate; view: SetupApplyView }): ReactNode {
  const reviewed = view.installed.filter(item => item.reviewChange !== undefined).map(item => item.name)
  return <div className={css.review} data-setup-done>
    <p className={css.notice} role="status">{t('transfer.done')}</p>
    {reviewed.length === 0 ? null : <p className={css.line}>{t(view.protection === 'on' ? 'transfer.done.review' : 'transfer.done.unreviewed', { names: reviewed.join(', ') })}</p>}
    <Lines title={t('transfer.done.keys')} lines={view.keys.map(key => keySentence(t, key))} />
  </div>
}
