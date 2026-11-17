/**
 * The report dialog: prepares the update, shows C3's report for it as text, asks for each item the update cannot
 * confirm by itself, offers the chat-data copy (ticked by default) and the choice to wait for chats or stop them, and
 * begins the update. Every sentence about an item comes from `@delorun/update`, the words `delorun update` prints, and
 * renders as text; the release note carries its label so the release's own words never read as Delorun's instruction.
 * The Host decides what must be ticked (`confirm.ticks`) and refuses an apply without it; this dialog asks.
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Modal, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReportItem, UpdateReport } from '@delorun/contract-update-report'
import { dataCopyNote, reasonMessage, UNVERIFIED_NOTE, uncheckedMessage } from '@delorun/update/messages'
import type { PreparedUpdateView, UpdateStateView } from '../wire.ts'
import type { Outcome, UpdateRefusal } from './controller.ts'
import css from './UpdatePanel.module.css'
import { controlUse, pluralKey, refusalText, sizeText, type T } from './parts.tsx'

/** What the dialog asks the controller to do. */
export interface UpdateDialogActions {
  readonly prepare: () => Promise<Outcome<PreparedUpdateView>>
  readonly apply: (body: { readonly handle: string, readonly chats: 'wait' | 'stop', readonly dataCopy: boolean, readonly acknowledged: readonly string[] }) => Promise<Outcome<unknown>>
}

/** Props of {@link UpdateDialog}. */
export interface UpdateDialogProps {
  readonly state: UpdateStateView
  readonly t: T
  readonly actions: UpdateDialogActions
  readonly onClose: () => void
  /** Open Settings → Changes, where pending changes to Delorun itself wait. */
  readonly openChanges: () => void
}

/** The dialog's read of the report: preparing, a refusal, or the prepared update. */
type Step =
  | { readonly kind: 'preparing' }
  | { readonly kind: 'refused', readonly refusal: UpdateRefusal }
  | { readonly kind: 'ready', readonly prepared: PreparedUpdateView }

/**
 * The name an item is listed under.
 * @param item - the item.
 * @returns its plugin, bundle, row or file name; the chat data's name for a data item.
 */
function itemName(item: ReportItem, t: T): string {
  switch (item.kind) {
    case 'plugin': return `${item.subject.name} ${item.subject.version}`
    case 'bundle': return item.subject.package
    case 'row': return item.subject.name
    case 'harness': return item.subject.file
    case 'data': return item.subject.directories.join(', ')
  }
}

/**
 * Render the dialog.
 * @param props - the state, the dictionary, the actions and the closers.
 * @returns the dialog.
 */
export function UpdateDialog({ state, t, actions, onClose, openChanges }: UpdateDialogProps) {
  const [step, setStep] = useState<Step>(() => state.prepared === undefined ? { kind: 'preparing' } : { kind: 'ready', prepared: state.prepared })
  const [dataCopy, setDataCopy] = useState(true)
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<UpdateRefusal | undefined>()
  const begin = controlUse(state, 'update-begin', t)
  const prepare = (): void => {
    setStep({ kind: 'preparing' })
    setFailed(undefined)
    void actions.prepare().then((outcome) => {
      setStep(outcome.ok ? { kind: 'ready', prepared: outcome.value } : { kind: 'refused', refusal: outcome.refusal })
    })
  }
  useEffect(() => {
    if (state.prepared === undefined) prepare()
    // Prepare once when the dialog opens with nothing held; later state reads must not prepare again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const lines = state.progress.kind === 'preparing' ? state.progress.lines : []
  if (step.kind === 'preparing') {
    return <Modal open onClose={onClose} title={t('dialog.title', { version: state.check.notice?.release.delorun ?? '' })} closeLabel={t('dialog.close')} className={String(css.dialog)}
      footer={<Button variant="outline" data-modal-autofocus onClick={onClose}>{t('dialog.cancel')}</Button>}>
      <p className={css.body} role="status">{t('dialog.preparing')}</p>
      {lines.length === 0 ? null : <pre className={css.lines} aria-label={t('dialog.preparing.lines')}>{lines.join('\n')}</pre>}
    </Modal>
  }
  if (step.kind === 'refused') {
    return <Modal open onClose={onClose} title={t('dialog.title', { version: state.check.notice?.release.delorun ?? '' })} closeLabel={t('dialog.close')} className={String(css.dialog)}
      footer={<>
        <Button variant="outline" data-modal-autofocus onClick={onClose}>{t('dialog.close')}</Button>
        {step.refusal.code === 'HARNESS_CHANGES_PENDING'
          ? <Button variant="primary" onClick={() => { onClose(); openChanges() }}>{t('blocked.changes')}</Button>
          : <Button variant="primary" onClick={prepare}>{t('dialog.retry')}</Button>}
      </>}>
      <p className={css.body} role="alert" data-update-refusal={step.refusal.code}>{refusalText(step.refusal, t)}</p>
    </Modal>
  }
  const { prepared } = step
  const { report, confirm } = prepared
  const needed = confirm.ticks.filter(key => key !== 'data-no-copy' || !dataCopy)
  const allTicked = needed.every(key => ticked.has(key))
  const blocked = confirm.blocked
  const canBegin = blocked === undefined && allTicked && !begin.disabled && !busy
  const versions = { from: report.from, to: report.to }
  const run = (chats: 'wait' | 'stop'): void => {
    setBusy(true)
    setFailed(undefined)
    void actions.apply({ handle: prepared.handle, chats, dataCopy, acknowledged: needed }).then((outcome) => {
      setBusy(false)
      if (outcome.ok) onClose()
      else if (outcome.refusal.code === 'REPORT_EXPIRED' || outcome.refusal.code === 'HARNESS_REPORT_STALE') setStep({ kind: 'refused', refusal: outcome.refusal })
      else setFailed(outcome.refusal)
    })
  }
  const toggle = (key: string): void => {
    setTicked((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  return <Modal open onClose={onClose} title={t('dialog.title', { version: report.to.delorun })} closeLabel={t('dialog.close')} className={String(css.dialog)}
    footer={<>
      <Button variant="outline" data-modal-autofocus onClick={onClose}>{t('dialog.cancel')}</Button>
      {blocked !== undefined || prepared.runningChats === 0 ? null
        : <Button variant="outline" className={css.danger} disabled={!canBegin} title={begin.title} onClick={() => { run('stop') }}>{t('confirm.stop')}</Button>}
      {blocked !== undefined
        ? null
        : <Button variant="primary" disabled={!canBegin} title={begin.title} onClick={() => { run('wait') }}>{t(prepared.runningChats === 0 ? 'confirm.now' : 'confirm.wait')}</Button>}
    </>}>
    <div className={css.dialogBody} data-update-report={report.to.delorun}>
      <p className={css.meta}>{t('report.checks', { signature: t(`report.${report.release.signature}`), freshness: t(`report.${report.release.freshness}`), log: t(report.release.log === 'passed' ? 'report.passed' : report.release.log === 'failed' ? 'report.failed' : 'report.unchecked') })}</p>
      <ReleaseNote note={prepared.releaseNote} t={t} />
      {blocked === undefined ? null : <p className={css.body} role="alert" data-update-blocked={blocked}>{t(`blocked.${blocked}`)}</p>}
      {blocked === 'harness-conflict' ? <div><Button variant="outline" size="sm" onClick={() => { onClose(); openChanges() }}>{t('blocked.changes')}</Button></div> : null}
      <Items report={report} versions={versions} ticks={confirm.ticks} ticked={ticked} toggle={toggle} t={t} />
      {report.notChecked.length === 0 ? null : <p className={css.meta}>{t('report.notChecked', { what: report.notChecked.map(uncheckedMessage).join(' ') })}</p>}
      {confirm.ticks.includes('log') ? <Checkbox className={css.tick} checked={ticked.has('log')} onChange={() => { toggle('log') }} label={t('tick.log')} /> : null}
      {confirm.dataItem === undefined ? null : <DataCopy report={report} item={report.items[confirm.dataItem]} dataCopy={dataCopy} setDataCopy={setDataCopy} versions={versions} tickedNoCopy={ticked.has('data-no-copy')} toggleNoCopy={() => { toggle('data-no-copy') }} t={t} />}
      <p className={css.body} role="status">{prepared.runningChats === 0 ? t('chats.none') : t(pluralKey('chats', prepared.runningChats), { count: prepared.runningChats })}</p>
      {failed === undefined ? null : <p className={css.body} role="alert" data-update-refusal={failed.code}>{refusalText(failed, t)}</p>}
    </div>
  </Modal>
}

/**
 * The release's own words, under a label so they never read as Delorun's instruction, as text.
 * @param props - the note and the dictionary.
 * @returns the note, or nothing.
 */
function ReleaseNote({ note, t }: { readonly note: string | undefined, readonly t: T }) {
  if (note === undefined || note === '') return null
  return <p className={css.body}><span className={css.releaseLabel}>{t('release.note')}</span> <span className={css.release} data-update-note>{note}</span></p>
}

/**
 * The report's items, each with its sentence, the tick it needs and a merged harness file's diff.
 * @param props - the report, the versions, the tick keys, what is ticked and the dictionary.
 * @returns the list, or the line that says nothing changes.
 */
function Items({ report, versions, ticks, ticked, toggle, t }: {
  readonly report: UpdateReport
  readonly versions: { readonly from: UpdateReport['from'], readonly to: UpdateReport['to'] }
  readonly ticks: readonly string[]
  readonly ticked: ReadonlySet<string>
  readonly toggle: (key: string) => void
  readonly t: T
}) {
  const shown = useMemo(() => report.items.map((item, index) => ({ item, index })).filter(({ item }) => item.kind !== 'data'), [report])
  if (shown.length === 0) return <p className={css.body}>{t('report.noChanges')}</p>
  return <section aria-label={t('report.changes')}>
    <h3 className={css.heading}>{t('report.changes')}</h3>
    <ul className={css.items}>
      {shown.map(({ item, index }) => {
        const key = `item:${String(index)}`
        const diff = item.detail.diff
        return <li key={key} className={css.item} data-update-item={item.reason}>
          <span className={css.itemName}>
            <StateDot state={item.effect === 'disabled' || item.effect === 'removed' ? 'warning' : 'idle'} />
            {itemName(item, t)}
            <Tag>{t(`report.item.${item.effect}`)}</Tag>
          </span>
          <span className={css.meta}>{reasonMessage(item, versions)}</span>
          {item.verification === 'unverified' ? <span className={css.meta}>{UNVERIFIED_NOTE}</span> : null}
          {diff === undefined ? null : diff.notShown === undefined
            ? <pre className={css.diff} aria-label={t('report.diff')}>{diff.text}</pre>
            : <span className={css.meta}>{t('report.diff.notShown', { why: t(`report.diff.${diff.notShown}`) })}</span>}
          {ticks.includes(key) ? <Checkbox className={css.tick} checked={ticked.has(key)} onChange={() => { toggle(key) }} label={t('tick.item')} /> : null}
        </li>
      })}
    </ul>
  </section>
}

/**
 * The chat-data item: the copy ticked by default with its size and room, and the sentence that says what declining it
 * costs, with the tick declining needs.
 * @param props - the report, its data item, the copy choice, and the tick for declining.
 * @returns the block.
 */
function DataCopy({ report, item, dataCopy, setDataCopy, versions, tickedNoCopy, toggleNoCopy, t }: {
  readonly report: UpdateReport
  readonly item: ReportItem | undefined
  readonly dataCopy: boolean
  readonly setDataCopy: (value: boolean) => void
  readonly versions: { readonly from: UpdateReport['from'], readonly to: UpdateReport['to'] }
  readonly tickedNoCopy: boolean
  readonly toggleNoCopy: () => void
  readonly t: T
}) {
  const copy = item?.detail.copy
  return <section className={css.item} data-update-data>
    <Checkbox className={css.tick} checked={dataCopy} onChange={() => { setDataCopy(!dataCopy) }} label={t('data.copy')} />
    {item === undefined ? null : <span className={css.meta}>{reasonMessage(item, versions)}</span>}
    {copy === undefined ? null : <span className={css.meta}>{t('data.copy.size', { files: copy.files, size: sizeText(copy.bytes, t), free: sizeText(copy.free, t) })}</span>}
    {dataCopy
      ? <span className={css.meta}>{t('data.copy.note', { from: report.from.delorun })}</span>
      : <>
        <span className={css.meta}>{dataCopyNote(versions)}</span>
        <Checkbox className={css.tick} checked={tickedNoCopy} onChange={toggleNoCopy} label={t('tick.data-no-copy', { from: report.from.delorun, to: report.to.delorun })} />
      </>}
  </section>
}
