/**
 * One change as the person reviews it: the plugin's folder, the files with their status, what the checks found with
 * the fixed sentence that the summary is a help and not a protection, the files the diff does not show, and the
 * bounded diff. Every name, line and message is rendered as text.
 */
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChangeView } from '../wire.ts'
import css from './ChangesSection.module.css'

/** Props of {@link ChangeDetail}. */
export interface ChangeDetailProps {
  readonly change: ChangeView
  readonly t: TranslateNS<'deloChanges'>
}

/**
 * The class of one diff line by its first character: a file header, a hunk header, an added or a removed line.
 * @param line - one line of the unified diff.
 * @returns the class, or undefined for a context line.
 */
function lineClass(line: string): string | undefined {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) return css.diffFile
  if (line.startsWith('@@')) return css.diffHunk
  if (line.startsWith('+')) return css.diffAdd
  if (line.startsWith('-')) return css.diffDel
  return undefined
}

/**
 * Render a change for review.
 * @param props - the change and the dictionary.
 * @returns the detail.
 */
export function ChangeDetail({ change, t }: ChangeDetailProps) {
  const { risk, diff } = change
  const notShown = risk.findings.filter(finding => finding.kind === 'not-shown')
  const lines = diff.text === '' ? [] : diff.text.replace(/\n$/, '').split('\n')
  return <div className={css.detail}>
    <p className={css.meta}>{t('review.folder', { folder: change.source })}</p>
    <section className={css.block} aria-label={t('review.risk')}>
      <h3 className={css.blockHeading}>{t('review.risk')}</h3>
      <p className={css.notice} role="note">{t('risk.notice')}</p>
      {risk.kinds.length === 0
        ? <p className={css.meta}>{t('risk.nothing')}</p>
        : <ul className={css.riskList}>
          {risk.kinds.map(kind => <li key={kind} data-risk-kind={kind}>
            <span className={css.riskKind}>{t(`risk.${kind}`)}</span>
            <span className={css.riskPlaces}>
              {[...new Set(risk.findings.filter(finding => finding.kind === kind && kind !== 'not-shown')
                .map(finding => finding.line === undefined ? finding.file : `${finding.file}:${String(finding.line)}`))].join(', ')}
            </span>
          </li>)}
        </ul>}
    </section>
    {notShown.length === 0 ? null : <section className={css.block} aria-label={t('review.notShown')}>
      <h3 className={css.blockHeading}>{t('review.notShown')}</h3>
      <ul className={css.plainList}>{notShown.map(finding => <li key={finding.excerpt}>{finding.excerpt}</li>)}</ul>
    </section>}
    <section className={css.block} aria-label={t('review.files')}>
      <h3 className={css.blockHeading}>{t('review.files')}</h3>
      <ul className={css.fileList}>
        {change.files.map(file => <li key={file.path} data-file-status={file.status}>
          <Tag tone={file.status === 'added' ? 'success' : file.status === 'removed' ? 'danger' : 'neutral'}>{t(`review.file.${file.status}`)}</Tag>
          <span className={css.path}>{file.path}</span>
          {file.binary ? <Tag tone="quiet">{t('review.file.binary')}</Tag> : null}
          {file.dependency ? <Tag tone="quiet">{t('review.file.dependency')}</Tag> : null}
        </li>)}
      </ul>
    </section>
    {change.skipped.length === 0 ? null : <section className={css.block}>
      <p className={css.meta}>{t('review.skipped')}</p>
      <ul className={css.plainList}>{change.skipped.map(path => <li key={path}>{path}</li>)}</ul>
    </section>}
    <section className={css.block} aria-label={t('review.diff')}>
      <h3 className={css.blockHeading}>{t('review.diff')}</h3>
      {lines.length === 0
        ? <p className={css.meta}>{t('review.noDiff')}</p>
        // The index is the line's identity: a diff repeats lines, and the list never reorders.
        : <pre className={css.diff}>{lines.map((line, index) => <span key={index} className={lineClass(line)}>{`${line}\n`}</span>)}</pre>}
      {diff.truncated || diff.omitted.length > 0
        ? <>
          <p className={css.meta}>{t('review.omitted')}</p>
          <ul className={css.plainList}>{diff.omitted.map(path => <li key={path}>{path}</li>)}</ul>
        </>
        : null}
    </section>
  </div>
}
