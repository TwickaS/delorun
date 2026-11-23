/** The phone's two presentations: the quiet row for the setup guide's footer, and the header icon with its bottom sheet. */
import { IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconCloseOutlineRegular, IconDownloadOutlineRegular, IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { ALERT_CLASSES } from '@delorun/brand/alert'
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { headerText } from './Card.tsx'
import { ItemList } from './Items.tsx'
import { Live } from './Live.tsx'
import { fallbackTranslate, type Translate } from './locales.ts'
import { useDownloadsModel, type PanelModel } from './model.ts'
import { claimOnboardingRow, currentDownloadsSource, providedTranslate, subscribeHub } from './source.ts'
import type { DownloadsSource } from './source.ts'
import css from './Phone.module.css'

/**
 * Follow the provided source.
 * @returns the source now provided.
 */
export function useHubSource(): DownloadsSource {
  return useSyncExternalStore(subscribeHub, currentDownloadsSource, currentDownloadsSource)
}

/** Props of {@link OnboardingDownloadsRow}. */
export interface OnboardingDownloadsRowProps {
  /** The copy; defaults to the plugin's bound translate. */
  readonly t?: Translate
  /** The source; defaults to the one the plugin provides. */
  readonly source?: DownloadsSource
  /** How long the completion summary stays, in milliseconds. */
  readonly summaryMs?: number
}

/**
 * The single quiet line the setup guide shows above Back and Continue while plugins install: muted small text, a thin
 * grey progress line, no accent and no motion beyond the progress. It renders nothing while the queue is empty. Tapping
 * it lists the plugins in place.
 * @param props - optional overrides for the copy and the source.
 * @returns the row, or nothing.
 */
export function OnboardingDownloadsRow({ t = providedTranslate() ?? fallbackTranslate, source: given, summaryMs }: OnboardingDownloadsRowProps): ReactNode {
  const provided = useHubSource()
  const source = given ?? provided
  const model = useDownloadsModel(source, summaryMs)
  const [open, setOpen] = useState(false)
  const listId = useId()
  useEffect(() => claimOnboardingRow(), [])
  return (
    <>
      <Live announcement={model.announcement} t={t} />
      {model.phase !== 'hidden' && (
        <div className={css.row} data-tone="quiet">
          {open && <div id={listId} className={css.list}><ItemList items={model.items} source={source} t={t} tone="quiet" label={t('list')} /></div>}
          <button type="button" className={css.line} aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => { setOpen(value => !value) }}>
            <span className={css.text}>{model.phase === 'working' ? `${headerText(model, t)} · ${String(model.percent)}%` : headerText(model, t)}</span>
            {model.failed > 0 && <span className={css.neutral} role="img" aria-label={t('row.failed')}><IconWarningOutlineRegular /></span>}
            {open ? <IconChevronDownOutlineRegular /> : <IconChevronUpOutlineRegular />}
          </button>
          <span className={css.thin} aria-hidden="true"><span style={{ width: `${String(model.percent)}%` }} /></span>
        </div>
      )}
    </>
  )
}

/**
 * The header icon with its count badge and the bottom sheet it opens.
 * @param props - the derived view, the source and the copy.
 * @returns the icon and sheet, or only the live region while nothing shows.
 */
export function DownloadsSheet({ model, source, t }: { readonly model: PanelModel; readonly source: DownloadsSource; readonly t: Translate }): ReactNode {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  // The badge and the header count the same thing: what is left to install, or what failed once nothing is left.
  const count = model.active > 0 ? model.active : model.failed
  const shown = model.phase !== 'hidden'
  useEffect(() => {
    if (open) closeButton.current?.focus()
  }, [open])
  useEffect(() => {
    if (!shown && open) setOpen(false)
  }, [shown, open])
  const close = (): void => { setOpen(false); trigger.current?.focus() }
  return (
    <>
      <Live announcement={model.announcement} t={t} />
      {shown && (
        <button ref={trigger} type="button" className={css.icon} aria-haspopup="dialog" aria-expanded={open} aria-label={t('sheet.open', { n: count })} onClick={() => { setOpen(true) }}>
          <IconDownloadOutlineRegular />
          {count > 0 && <span className={css.badge} aria-hidden="true">{count}</span>}
        </button>
      )}
      {shown && open && (
        <div className={css.backdrop} onClick={close}>
          <div className={`${ALERT_CLASSES.glass} ${css.sheet}`} role="dialog" aria-modal="true" aria-label={t('title')} onClick={(event) => { event.stopPropagation() }}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>
            <div className={css.sheetHeader}>
              <span className={css.sheetTitle}>{headerText(model, t)}</span>
              <button ref={closeButton} type="button" className={css.close} aria-label={t('sheet.close')} onClick={close}><IconCloseOutlineRegular /></button>
            </div>
            <ItemList items={model.items} source={source} t={t} tone="card" label={t('list')} />
          </div>
        </div>
      )}
    </>
  )
}
